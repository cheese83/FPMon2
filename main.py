import gzip
import json
import logging
import ssl
from codecs import open
from configparser import ConfigParser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from mimetypes import guess_type
from os import getcwd
from os.path import isfile, realpath, splitext
from random import randint
from socket import gethostbyname, gethostname
from socketserver import ThreadingMixIn
from subprocess import run
from urllib.parse import urlparse
from urllib.request import Request, urlopen

config = ConfigParser()
config.read('config.ini')

services = config.items('IpAddressServices')
serviceIndex = randint(0, len(services) - 1)
serviceIntervalSeconds = 7 * 60
lastPublicIPAddressTime = None
lastPublicIPAddress = None


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args):
        self.defaultFile = 'index.html'
        self.allowedTypes = ['.html', '.css', '.js', '.ttf', '.svg']
        self.propertyGetters = {'machine_name': self.get_machine_name,
                                'processor_name': self.get_processor_name,
                                'processor_utilization': self.get_processor_utilization,
                                'local_ip_address': self.get_local_ip_address,
                                'public_ip_address': self.get_public_ip_address,
                                'up_time': self.get_up_time,
                                'physical_memory': self.get_physical_memory,
                                'memory_utilization': self.get_memory_utilization,
                                'logical_disk': self.get_logical_disk,
                                'logical_disk_perf': self.get_logical_disk_perf,
                                'network': self.get_network,
                                'network_perf': self.get_network_perf}

        BaseHTTPRequestHandler.__init__(self, *args)

    def do_GET(self):
        if self.path.endswith('/'):
            self.path = self.path + self.defaultFile

        parsed_url = urlparse(self.path)
        base_path = getcwd()
        real_path = realpath(base_path + parsed_url.path)

        # realpath must be used on both paths being compared, otherwise they may appear different if there are things
        # like symlinks involved.
        if not real_path.startswith(realpath(base_path)):
            logging.warning(f'Request made to path outside base path: {self.path}')
            self.send_error(403)

        extension = splitext(real_path)[1]
        try:
            if extension in self.allowedTypes:
                self.serve_file(real_path)
            else:
                self.serve_property(parsed_url.path)
        except BaseException as err:
            logging.exception(f'Exception serving request for {self.path}')
            self.send_response(500, message=f'{err}')
            self.end_headers()

    def serve_file(self, path):
        if not isfile(path):
            logging.info(f'File not found: {path}')
            self.send_error(404)
        else:
            (contentType, encoding) = guess_type(path)
            file = open(path, 'rb')
            data = gzip.compress(bytes(file.read()))
            file.close()
            self.send_response(200)
            self.send_header('content-encoding', 'gzip')
            self.send_header('Content-Type', contentType)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def serve_property(self, path):
        getter = self.propertyGetters.get(path.lstrip('/'))
        if getter is None:
            logging.info(f'Property getter not found: {path}')
            self.send_error(404)
        else:
            data = getter()
            self.log_request(200)
            # Avoid send_response here so the default headers are not added.
            self.send_response_only(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(bytes(data, 'utf8'))

    @staticmethod
    def run_powershell_command(command):
        args = ['powershell', '-noprofile', '-command', command]
        process = run(args, capture_output=True, text=True)
        return process.stdout

    @staticmethod
    def generate_ciminstance_command(wmi_class, wmi_property, where='', select=''):
        # "-property" limits which properties are read, compared to "select" which only limits what is returned.
        # This is important for performance with some queries.
        components = ['Get-CimInstance', '-ClassName', wmi_class, '-Property', wmi_property]
        if where != '' and where is not None:
            components += [f'| where {where}']
        if select is not None:
            components += [f'| select {select if select != "" else wmi_property}']
        return ' '.join(components)

    @staticmethod
    def generate_cimassociatedinstance_command(input_object, association, key_only=False):
        components = ['Get-CimAssociatedInstance', '-InputObject', f'({input_object})[0]', '-Association', association]
        if key_only:
            components += ['-KeyOnly']
        return ' '.join(components)

    @classmethod
    def generate_convertto_command(cls, command, as_array=False, to='Json'):
        # The result is passed as an argument to ConvertTo-Json rather than being piped to it because that makes it
        # easier to force the returned JSON to be an array (see following comment).
        # @( ) is the "array subexpression operator", which ensures that an array is returned even if there's only one
        # element.
        return f'ConvertTo-{to} @({command})' if as_array else f'ConvertTo-{to} ({command})'

    @staticmethod
    def get_machine_name():
        return json.dumps({'Name': [gethostname()]})

    def get_processor_name(self):
        command = self.generate_ciminstance_command('Win32_Processor', 'Name')
        name = self.run_powershell_command(f'({command}).Name')
        return json.dumps({'Name': name})

    def get_processor_utilization(self):
        command = self.generate_ciminstance_command('Win32_PerfFormattedData_PerfOS_Processor',
                                                    'Name,PercentProcessorTime',
                                                    select=None)
        result = self.run_powershell_command(f'({command} | foreach {{$_.PercentProcessorTime}}) -join ","')
        return f'[{result}]'

    @staticmethod
    def get_local_ip_address():
        address = gethostbyname(gethostname())
        return json.dumps({'IPAddress': address})

    @staticmethod
    def get_public_ip_address():
        global services, serviceIndex, serviceIntervalSeconds, lastPublicIPAddress, lastPublicIPAddressTime
        if lastPublicIPAddress is None or (
                lastPublicIPAddressTime is not None
                and (datetime.now() - lastPublicIPAddressTime).total_seconds() > serviceIntervalSeconds):
            service = services[serviceIndex][1]
            serviceIndex = (serviceIndex + 1) % len(services)
            # Remove user agent because some services don't seem to like the default 'Python-urllib/3.10'
            # Have to set it to blank because not setting it means it will be set to the default.
            req = Request(service, headers={'User-Agent': ''})
            # Don't care about certificate errors.
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            try:
                with urlopen(req, context=ctx, timeout=30) as response:
                    lastPublicIPAddress = str(response.read(), 'utf-8').rstrip('\n')
            except BaseException as err:
                raise Exception(f'{err} {service}')
            lastPublicIPAddressTime = datetime.now()

        return json.dumps({'IPAddress': lastPublicIPAddress})

    def get_up_time(self):
        # Use PerfRawData because it's faster than PerfFormattedData, but the returned value needs converting to be
        # useable.
        command = self.generate_ciminstance_command('Win32_PerfRawData_PerfOS_System', 'SystemUpTime', select=None)
        timestamp = int(self.run_powershell_command(f'({command}).SystemUpTime'))
        # Convert LDAP timestamp to seconds before now.
        boot_time = datetime(1601, 1, 1) + timedelta(microseconds=timestamp / 10)
        up_time = (datetime.now() - boot_time).total_seconds()
        return json.dumps({'SystemUpTime': round(up_time)})

    def get_physical_memory(self):
        # TODO: This will fail in a VM. Maybe fall back to Win32_ComputerSystem.TotalPhysicalMemory
        # for the capacity in that case, and 0/'Unknown' for all the other values.
        # Could limit this to system memory (Use = 3), but it's unlikely there would be any other type here.
        error_correction_command = self.generate_ciminstance_command('Win32_PhysicalMemoryArray',
                                                                     'MemoryErrorCorrection',
                                                                     select=None)
        phys_command = self.generate_ciminstance_command('Win32_PhysicalMemory',
                                                         'Capacity,ConfiguredClockSpeed,SMBIOSMemoryType',
                                                         select=None)
        # This assums that all installed memory modules have the same speed and type.
        new_obect = f'%{{New-Object psobject @{{ ConfiguredClockSpeed = $_.Group[0].ConfiguredClockSpeed; SMBIOSMemoryType = $_.Group[0].SMBIOSMemoryType; Capacity = ($_.Group | measure Capacity -Sum).Sum; MemoryErrorCorrection = ({error_correction_command}).MemoryErrorCorrection }}}}'
        command = f'{phys_command} | group ConfiguredClockSpeed,SMBIOSMemoryType | {new_obect} | ConvertTo-Json'
        return self.run_powershell_command(command)

    def get_memory_utilization(self):
        # TotalVisibleMemorySize will be less than the total physical memory installed.
        command = self.generate_ciminstance_command('Win32_OperatingSystem',
                                                    'FreePhysicalMemory,TotalVisibleMemorySize,FreeSpaceInPagingFiles,TotalVirtualMemorySize')
        return self.run_powershell_command(self.generate_convertto_command(command))

    def get_logical_disk(self):
        # Working out which physical disk a logical disk resides on means working back through multiple layers of
        # association. Logical disk -> partition -> physical disk.
        partition_command = self.generate_cimassociatedinstance_command('$disk',
                                                                        'Win32_LogicalDiskToPartition',
                                                                        key_only=True)
        physical_disk_command = self.generate_cimassociatedinstance_command(partition_command,
                                                                            'Win32_DiskDriveToDiskPartition')
        outer_command = self.generate_ciminstance_command('Win32_LogicalDisk',
                                                          'DriveType,Name,Size,FreeSpace',
                                                          # 3 = local drive.
                                                          'DriveType -eq 3',
                                                          select=None)
        command = f'{outer_command} | foreach {{ $disk = $_; select -inputobject $disk -property Name,Size,FreeSpace,Caption | foreach {{$_.Caption = ({physical_disk_command}).Caption; $_}} }} | select Name,Size,FreeSpace,Caption'
        result = self.run_powershell_command(self.generate_convertto_command(command, as_array=True))
        return result

    def get_logical_disk_perf(self):
        command = self.generate_ciminstance_command('Win32_PerfFormattedData_PerfDisk_LogicalDisk',
                                                    'Name,DiskReadBytesPersec,DiskWriteBytesPersec',
                                                    # Names that are a single char followed by a colon should include
                                                    # all the local drives.
                                                    'Name -match "^.:$"',
                                                    'DiskReadBytesPersec,DiskWriteBytesPersec')
        return self.run_powershell_command(self.generate_convertto_command(command, as_array=True))

    def get_network(self):
        # Use PerfRawData instead of PerfFormattedData because it's faster, and CurrentBandwidth doesn't need any
        # calculations applied.
        perf_command = self.generate_ciminstance_command('Win32_PerfRawData_Tcpip_NetworkInterface',
                                                         'Name,CurrentBandwidth',
                                                         # Assume that there is one connected adapter, which will be the
                                                         # one that has a non-zero bandwidth.
                                                         'CurrentBandwidth')
        # The name is displayed on the chart, so send the description from the adpater config, which hasn't had
        # various characters replaced.
        conf_command = self.generate_ciminstance_command('Win32_NetworkAdapterConfiguration',
                                                         'Description,DefaultIPGateway',
                                                         # Assume a single connected adapter, which should have a
                                                         # DefaultIPGateway
                                                         'DefaultIPGateway',
                                                         select=None)
        command = f'{perf_command} -first 1 | foreach {{ $_.Name = ({conf_command})[0].Description; $_ }} | select Name,CurrentBandwidth'
        return self.run_powershell_command(self.generate_convertto_command(command))

    def get_network_perf(self):
        command = self.generate_ciminstance_command('Win32_PerfFormattedData_Tcpip_NetworkInterface',
                                                    'CurrentBandwidth,BytesReceivedPersec,BytesSentPersec',
                                                    # Assume that there is one connected adapter, which will be the
                                                    # one that has a non-zero bandwidth.
                                                    'CurrentBandwidth',
                                                    'BytesReceivedPersec,BytesSentPersec')
        return self.run_powershell_command(self.generate_convertto_command(command))


# The server has to be multithreaded otherwise it will slow down if there are two clients running.
class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    pass


logging.basicConfig(filename=f'{date.today().isoformat()}.log', format='%(asctime)s %(message)s',
                    level=config.get('Logging', 'Level'))
logging.info('FPMon started')

with ThreadedHTTPServer(('', config.getint('Server', 'Port')), Handler) as server:
    server.serve_forever()
