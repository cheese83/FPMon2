(function () {
	'use strict';

	const sleep = (delay) => new Promise(resolve => setTimeout(resolve, delay));
	const formatDuration = (x) => {
		const minutes = Math.trunc(x / 60) % 60;
		const hours = Math.trunc(x / (60 * 60)) % 24;
		const days = Math.trunc(x / (60 * 60 * 24));

		return `${days}d ${hours}h ${minutes}m`;
	};

	const xAxisRangeMinutes = 10;
	const xAxisRangeMilliseconds = xAxisRangeMinutes * 60 * 1000;
	const commonChartOptions = {
		showArea: true,
		showLine: true,
		showPoint: false,
		axisX: {
			type: Chartist.FixedScaleAxis,
			divisor: xAxisRangeMinutes,
			labelInterpolationFnc: (value) => {
				const delta = (Date.now() - value) / (60 * 1000);
				return `${delta.toFixed(0)}m`;
			},
			offset: 15
		},
		axisY: {
			offset: 33,
			labelOffset: { x: 4, y: 2 }
		},
		chartPadding: {
			top: 15,
			right: 3,
			bottom: 0,
			left: 0
		}
	};
	// Sadly Chartist doesn't support relative units, so padding must be set at specific resolutions to accomodate labels that are sized in ems.
	// Up to 4k should be enough. Note that these are scaled by the device's DPI, so the last one is suitable for a 4k display at 100% or an 8k display at 200%.
	const commonResponsiveOption = [
		['(min-height: 600px)', {
			chartPadding: {
				top: 19,
				right: 3,
				bottom: 4,
				left: 10
			}
		}],
		['(min-height: 768px)', {
			chartPadding: {
				top: 24,
				right: 4,
				bottom: 9,
				left: 22
			}
		}],
		['(min-height: 900px)', {
			chartPadding: {
				top: 34,
				right: 6,
				bottom: 19,
				left: 42
			}
		}],
		['(min-height: 1080px)', {
			chartPadding: {
				top: 45,
				right: 9,
				bottom: 30,
				left: 68
			}
		}],
		['(min-height: 1440px)', {
			chartPadding: {
				top: 60,
				right: 12,
				bottom: 45,
				left: 100
			}
		}],
		['(min-height: 2160px)', {
			chartPadding: {
				top: 90,
				right: 18,
				bottom: 75,
				left: 165
			}
		}]
	];
	const percentChartOptions = Object.assign({}, commonChartOptions, {
		axisY: Object.assign({
			onlyInteger: true,
			high: 100,
			low: 0
		}, commonChartOptions.axisY)
	});
	const logDataRateChartOptions = Object.assign({}, commonChartOptions, {
		axisY: Object.assign({
			type: Chartist.FixedScaleAxis,
			onlyInteger: true,
			labelInterpolationFnc: (value) => {
				if (value % 3 > 0)
					return '';
				const engOom = Math.trunc(value / 3);
				const units = [
					'B/s',
					'kB/s',
					'MB/s',
					'GB/s',
					'TB/s' // Eventually!
				];
				return units[engOom];
			},
			low: 0,
			ticks: [0,3,6,9,12]
		}, commonChartOptions.axisY)
	});

	const trimSeries = (series, minTime) => {
		for (const s of series) {
			while (s.length && s[0].x < minTime) {
				s.shift();
			}
		}
	};

	const cpuData = { series: [] };
	const cpuOptions = Object.assign({}, percentChartOptions);
	const cpuChart = new Chartist.Line('#cpu .chart', cpuData, cpuOptions, commonResponsiveOption);
	const updateCpuChart = async () => {
		const response = await fetch('processor_utilization');
		const data = await response.json();
		const nowMilliseconds = Date.now();
		const seriesSum = (previous, current, index) => {
			if (index >= cpuData.series.length)
				cpuData.series[index] = [];

			const total = previous + (current / data.length);
			cpuData.series[index].push({x: nowMilliseconds, y: total});
			return total;
		};

		// The last element is the total, which isn't needed.
		data.pop();
		// By sorting the data, overlap between series on the charts will be minimized, making it easier to spot high single-thread use.
		data.sort((e1, e2) => e1 - e2).reduce(seriesSum, 0);
		cpuOptions.axisX.high = nowMilliseconds;
		cpuOptions.axisX.low = cpuOptions.axisX.high - xAxisRangeMilliseconds;
		trimSeries(cpuData.series, cpuOptions.axisX.low);
		cpuChart.update(cpuData, cpuOptions);
	};

	// From https://docs.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemoryarray
	const eccType = [
		'Reserved',
		'Other',
		'Unknown',
		'None',
		'Parity',
		'Single-bit ECC',
		'Multi-bit ECC',
		'CRC'
	];
	// From https://docs.microsoft.com/en-gb/windows/win32/cimwin32prov/win32-physicalmemory
	// Note that DDR5 is missing as of 2022-02-12
	const memoryType = [
		'Unknown',
		'Other',
		'DRAM',
		'Synchronous DRAM',
		'Cache DRAM',
		'EDO',
		'EDRAM',
		'VRAM',
		'SRAM',
		'RAM',
		'ROM',
		'Flash',
		'EEPROM',
		'FEPROM',
		'EPROM',
		'CDRAM',
		'3DRAM',
		'SDRAM',
		'SGRAM',
		'RDRAM',
		'DDR',
		'DDR2',
		'DDR2 FB-DIMM',
		'Invalid', // 23 is missing from the list in Microsoft's docs.
		'DDR3',
		'FBD2',
		'DDR4'
	];
	const memData = { series: [[],[]] };
	const memOptions = Object.assign({
		plugins: [Chartist.plugins.legend({ legendNames: ['Page', 'RAM'] })]
	}, percentChartOptions);
	const memChart = new Chartist.Line('#mem .chart', memData, memOptions, commonResponsiveOption);
	const updateMemChart = async () => {
		const response = await fetch('memory_utilization');
		const data = await response.json();
		const nowMilliseconds = Date.now();
		const physicalUsage = 1 - (data.FreePhysicalMemory / data.TotalVisibleMemorySize);
		// Technically this is everything except RAM, not just the page file, but it seems reasonable to assume that the only memory available is physical RAM + page file.
		const pageSize = data.TotalVirtualMemorySize - data.TotalVisibleMemorySize;
		const pageUsage = 1 - (data.FreeSpaceInPagingFiles / pageSize);

		memData.series[0].push({x: nowMilliseconds, y: pageUsage * 100});
		memData.series[1].push({x: nowMilliseconds, y: physicalUsage * 100});
		memOptions.axisX.high = nowMilliseconds;
		memOptions.axisX.low = memOptions.axisX.high - xAxisRangeMilliseconds;
		trimSeries(memData.series, memOptions.axisX.low);
		memChart.update(memData, memOptions);
	};

	const netData = { series: [[],[]] };
	const netOptions = Object.assign({
		plugins: [Chartist.plugins.legend({ legendNames: ['Rx', 'Tx'] })]
	}, logDataRateChartOptions);
	const netChart = new Chartist.Line('#net .chart', netData, netOptions, commonResponsiveOption);
	const updateNetChart = async () => {
		const response = await fetch('network_perf');
		const data = await response.json();
		const nowMilliseconds = Date.now();

		netData.series[0].push({x: nowMilliseconds, y: Math.max(Math.log10(data.BytesReceivedPersec), 0)});
		netData.series[1].push({x: nowMilliseconds, y: Math.max(Math.log10(data.BytesSentPersec), 0)});
		netOptions.axisX.high = nowMilliseconds;
		netOptions.axisX.low = netOptions.axisX.high - xAxisRangeMilliseconds;
		trimSeries(netData.series, netOptions.axisX.low);
		netChart.update(netData, netOptions);
	};

	const diskData = [
		{ series: [[],[]] },
		{ series: [[],[]] }
	];
	const diskOptions = [
		Object.assign({}, logDataRateChartOptions, {
			axisY: Object.assign({}, logDataRateChartOptions.axisY, { high: 10 }),
			plugins: [Chartist.plugins.legend({ legendNames: ['Read', 'Write'] })]
		}),
		Object.assign({}, logDataRateChartOptions, {
			axisY: Object.assign({}, logDataRateChartOptions.axisY, { high: 10 }),
			plugins: [Chartist.plugins.legend({ legendNames: ['Read', 'Write'] })]
		})
	];
	const diskChart = [
		new Chartist.Line('#disk-0 .chart', diskData[0], diskOptions[0], commonResponsiveOption),
		new Chartist.Line('#disk-1 .chart', diskData[1], diskOptions[1], commonResponsiveOption)
	];
	const updateDiskCharts = async () => {
		const response = await fetch('logical_disk_perf');
		const data = await response.json();
		const nowMilliseconds = Date.now();
		const updateDiskChart = (index) => {
			diskData[index].series[0].push({x: nowMilliseconds, y: Math.max(Math.log10(data[index].DiskReadBytesPersec), 0)});
			diskData[index].series[1].push({x: nowMilliseconds, y: Math.max(Math.log10(data[index].DiskWriteBytesPersec), 0)});
			diskOptions[index].axisX.high = nowMilliseconds;
			diskOptions[index].axisX.low = diskOptions[index].axisX.high - xAxisRangeMilliseconds;
			trimSeries(diskData[index].series, diskOptions[index].axisX.low);
			diskChart[index].update(diskData[index], diskOptions[index]);
		};
		updateDiskChart(0);
		updateDiskChart(1);
	};

	const diskSpaceData = [
		{ series: [[]] },
		{ series: [[]] }
	];
	const diskSpaceOptions = {
		axisX: {
			offset: 15
		},
		axisY: {
			low: 0,
			high: 100,
			offset: 5,
			onlyInteger: true,
			showLabel: false
		},
		chartPadding: commonChartOptions.chartPadding
	};
	const diskSpaceResponsiveOptions = [
		['(min-height: 600px)', {
			axisX: { offset: 19 },
			axisY: { offset: 7 }
		}],
		['(min-height: 768px)', {
			axisX: { offset: 24 },
			axisY: { offset: 8 }
		}],
		['(min-height: 900px)', {
			axisX: { offset: 34 },
			axisY: { offset: 12 }
		}],
		['(min-height: 1080px)', {
			axisX: { offset: 45 },
			axisY: { offset: 15 }
		}],
		['(min-height: 1440px)', {
			axisX: { offset: 60 },
			axisY: { offset: 20 }
		}],
		['(min-height: 2160px)', {
			axisX: { offset: 90 },
			axisY: { offset: 30 }
		}]
	];
	const diskSpaceChart = [
		new Chartist.Bar('#disk-0 .side-chart', diskSpaceData[0], diskSpaceOptions, diskSpaceResponsiveOptions),
		new Chartist.Bar('#disk-1 .side-chart', diskSpaceData[1], diskSpaceOptions, diskSpaceResponsiveOptions)
	];

	const updateTime = () => {
		const now = new Date();
		const format = { weekday: 'short',  day: 'numeric', month: 'short', year: 'numeric' };
		const formatter = new Intl.DateTimeFormat('en-GB', format);
		const parts = formatter.formatToParts(now);
		const formattedDate = parts.map(({type, value}) => {
			switch (type) {
				case 'day': return value + (value % 10 > 3 || (value > 10 && value < 14) ? 'th' : ['th','st','nd','rd'][value % 10])
				case 'literal': return [',', ' '].includes(value[0]) ? '' : value;
				default: return value;
			}
		}).filter(value => value !== '').join(' ');
		document.querySelector('#sys .date td').textContent = formattedDate;
		document.querySelector('#sys .time td').textContent = now.toLocaleTimeString([], { hour12: false });
	};
	const updateUptime = async () => {
		try {
			const response = await fetch('up_time');
			const data = await response.json();
			document.querySelector('#sys .uptime td').textContent = formatDuration(data.SystemUpTime);
		} catch (e) {
			console.log(e);
		}
	};
	const updateTimes = async (delay) => {
		await Promise.all([updateUptime(), updateTime(), sleep(delay)]);
		for (let i = 0; i < 60; i++) {
			await sleep(delay);
			updateTime();
		}
		setTimeout(updateTimes, 0, delay);
	};

	const updateCharts = async (delay) => {
		await Promise.all([(async () => {
			try {
				await updateCpuChart();
				await updateMemChart();
				await updateNetChart();
				await updateDiskCharts();
			} catch (e) {
				// Catch inside Promise.all so it always waits for the sleep instead of failing fast.
				// Otherwise it would retry too fast on error.
				console.log(e);
			}
		})(), sleep(delay)]);
		setTimeout(updateCharts, 0, delay);
	};

	const updateMachineName = async () => {
		const td = document.querySelector('#sys .name td');
		try {
			const response = await fetch('machine_name');
			const data = await response.json();
			td.textContent = data.Name;
		} catch (e) {
			td.textContent = '';
			console.log(e);
		}
	};
	const updateLocalIpAddress = async () => {
		const td = document.querySelector('#sys .local td');
		try {
			const response = await fetch('local_ip_address');
			const data = await response.json();
			// To trigger the CSS animation when the address changes, the content must first be set to empty
			// and then left like that long enough for the :empty selector to pick it up.
			if (td.textContent != data.IPAddress) {
				td.textContent = '';
			}
			setTimeout(() => td.textContent = data.IPAddress, 0);
		} catch (e) {
			td.textContent = '';
			console.log(e);
		}
	};
	const updateLocalNetProperties = async (delay) => {
		await Promise.all([(async () => {
			await updateMachineName();
			await updateLocalIpAddress();
		})(), sleep(delay)]);
		setTimeout(updateLocalNetProperties, 0, delay);
	};

	const updateCpuTitle = async () => {
		const response = await fetch('processor_name');
		const data = await response.json();
		document.querySelector('#cpu .chart .chart-title').textContent = data.Name;
	};
	const updateMemTitle = async () => {
		const response = await fetch('physical_memory');
		const data = await response.json();
		document.querySelector('#mem .chart .chart-title').textContent = `${data.Capacity / (1024 * 1024 * 1024)}GB ${memoryType[data.SMBIOSMemoryType]} ${data.ConfiguredClockSpeed}MHz ${eccType[data.MemoryErrorCorrection]}`;
	};
	const updateDiskTitles = async () => {
		const response = await fetch('logical_disk');
		const data = await response.json();
		const updateDiskDetails = (index) => {
			document.querySelector(`#disk-${index} .chart .chart-title`).textContent = `${data[index].Name} ${Math.round(data[index].Size / (1024 * 1024 * 1024))}GB ${data[index].Caption}`;

			diskSpaceData[index].series[0][0] = (1 - (data[index].FreeSpace / data[index].Size)) * 100;
			diskSpaceChart[index].update(diskSpaceData[index], diskSpaceOptions);
		};
		updateDiskDetails(0);
		updateDiskDetails(1);
	};
	const updateNetTitle = async () => {
		const response = await fetch('network');
		const data = await response.json();
		document.querySelector('#net .chart .chart-title').textContent = `${data.CurrentBandwidth / (1000 * 1000 * 1000)}Gbps ${data.Name}`;
		const bandwidthBytesPerSecond = data.CurrentBandwidth / 8;
		netOptions.axisY.high = Math.ceil(Math.log10(bandwidthBytesPerSecond));
		netOptions.axisY.divisor = Math.trunc(netOptions.axisY.high / 3);
	}
	const updateTitles = async (delay) => {
		await Promise.all([(async () => {
			try {
				// Some of thse are unlikely to change while the machine is running, but update them all periodically anyway.
				await updateCpuTitle();
				await updateMemTitle();
				await updateDiskTitles();
				await updateNetTitle();
			} catch (e) {
				console.log(e);
			}
		})(), sleep(delay)]);
		setTimeout(updateTitles, 0, delay);
	};

	const updatePublicIpAddress = async (delay) => {
		await Promise.all([(async () => {
			const td = document.querySelector('#sys .public td');
			try {
				const response = await fetch('public_ip_address');
				const data = await response.json();
				td.textContent = data.IPAddress;
			} catch(e) {
				td.textContent = '';
				console.log(e);
			}
		})(), sleep(delay)]);
		setTimeout(updatePublicIpAddress, 0, delay);
	};

	const hideCursorWhenInactive = (delay) => {
		let timer = 0;
		const start = () => {
			clearTimeout(timer);
			document.body.classList.remove('inactive');
			timer = setTimeout(() => document.body.classList.add('inactive'), delay);
		};
		timer = start();
		window.addEventListener('mousemove', start);
	};

	updateTimes(1000);
	updateCharts(4 * 1000);
	updateLocalNetProperties(61 * 1000);
	updateTitles(97 * 1000);
	updatePublicIpAddress(8 * 60 * 1000);

	hideCursorWhenInactive(10 * 1000);
}());
