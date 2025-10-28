// --- STATE MANAGEMENT ---
let dataSet = null;
let analysisResults = null;
let isLoading = false;

// --- DOM ELEMENT REFERENCES ---
const fileUploadArea = document.getElementById('file-upload-area');
const fileUploadInput = document.getElementById('file-upload-input');
const analysisOptions = document.getElementById('analysis-options');
const datasetDimensions = document.getElementById('dataset-dimensions');
const datasetPoints = document.getElementById('dataset-points');
const findOutliersBtn = document.getElementById('find-outliers-btn');
const errorDisplay = document.getElementById('error-display');
const resultsContainer = document.getElementById('results-container');
const plotToggleContainer = document.getElementById('plot-toggle-container');
const showPlotCheckbox = document.getElementById('show-plot-checkbox');

// --- SERVICE: PARSER LOGIC ---
const parseData = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target?.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                if (json.length < 2) {
                    throw new Error('Dataset must have a header row and at least one data row.');
                }
                
                const headers = json[0].map(String);
                const rows = json.slice(1);
                
                const dataPoints = rows.map((row, index) => {
                    const values = row.map(cell => parseFloat(String(cell))).filter(v => !isNaN(v));
                    if (values.length !== headers.length) {
                       console.warn(`Row ${index + 1} has mismatched number of numeric columns. Skipping.`);
                       return null;
                    }
                    return { index: index, values: values };
                }).filter(p => p !== null);

                if (dataPoints.length === 0) {
                     throw new Error('No valid numeric data found in the file. Please ensure columns are numeric.');
                }

                const dimensions = dataPoints[0].values.length;
                if (dimensions === 0 || dimensions > 3) {
                    throw new Error(`Unsupported number of dimensions: ${dimensions}. Only 1D, 2D, and 3D data are supported.`);
                }
                
                resolve({
                    data: dataPoints,
                    headers: headers,
                    dimensions: dimensions,
                });
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsBinaryString(file);
    });
};

// --- SERVICE: OUTLIER DETECTION LOGIC ---
const getStats = (data) => {
    if (data.length === 0) return { q1: 0, q3: 0, iqr: 0, mean: 0, stdDev: 0, median: 0, mad: 0 };
    const sorted = [...data].sort((a, b) => a - b);
    const n = sorted.length;
    const q1 = sorted[Math.floor(n / 4)];
    const median = sorted[Math.floor(n / 2)];
    const q3 = sorted[Math.floor((n * 3) / 4)];
    const iqr = q3 - q1;
    const mean = data.reduce((a, b) => a + b, 0) / n;
    const stdDev = Math.sqrt(data.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / n);
    const residuals = data.map(x => Math.abs(x - median));
    const sortedResiduals = [...residuals].sort((a, b) => a - b);
    const mad = sortedResiduals[Math.floor(sortedResiduals.length / 2)];
    return { q1, q3, iqr, mean, stdDev, median, mad };
};

const findOutliersIQR = (columnData) => {
    const values = columnData.map(d => d.value);
    const { q1, q3, iqr } = getStats(values);
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    return columnData.filter(d => d.value < lowerBound || d.value > upperBound).map(d => d.index);
};
const findOutliersZScore = (columnData, threshold = 3.0) => {
    const values = columnData.map(d => d.value);
    const { mean, stdDev } = getStats(values);
    if (stdDev === 0) return [];
    return columnData.filter(d => Math.abs((d.value - mean) / stdDev) > threshold).map(d => d.index);
};
const findOutliersModifiedZScore = (columnData, threshold = 3.5) => {
    const values = columnData.map(d => d.value);
    const { median, mad } = getStats(values);
    if (mad === 0) return [];
    return columnData.filter(d => Math.abs(0.6745 * (d.value - median) / mad) > threshold).map(d => d.index);
};
const findOutliersGrubbs = (columnData) => {
    const values = columnData.map(d => d.value);
    if (values.length < 3) return [];
    const { mean, stdDev } = getStats(values);
    if (stdDev === 0) return [];
    let maxDev = 0;
    let outlierIndex = -1;
    columnData.forEach(d => {
        const dev = Math.abs(d.value - mean) / stdDev;
        if (dev > maxDev) {
            maxDev = dev;
            outlierIndex = d.index;
        }
    });
    const criticalValue = 2.0;
    return maxDev > criticalValue ? [outlierIndex] : [];
};
const findOutliersESD = (columnData, maxOutliers = Math.floor(columnData.length * 0.1)) => {
    if (columnData.length < 5) return [];
    let currentData = [...columnData];
    const outliers = [];
    for(let i=0; i<maxOutliers; i++) {
        if (currentData.length < 3) break;
        const { mean, stdDev } = getStats(currentData.map(d => d.value));
        if (stdDev === 0) break;
        let maxDeviation = -1, potentialOutlierIndex = -1, dataIndexToRemove = -1;
        currentData.forEach((d, idx) => {
            const R = Math.abs(d.value - mean) / stdDev;
            if (R > maxDeviation) {
                maxDeviation = R;
                potentialOutlierIndex = d.index;
                dataIndexToRemove = idx;
            }
        });
        const criticalValue = 2.5;
        if(maxDeviation > criticalValue && dataIndexToRemove !== -1) {
            outliers.push(currentData[dataIndexToRemove]);
            currentData.splice(dataIndexToRemove, 1);
        } else {
            break;
        }
    }
    return outliers.map(o => o.index);
};
const findOutliersDixonQ = (columnData) => {
    const n = columnData.length;
    if (n < 3 || n > 30) return [];
    const sortedData = [...columnData].sort((a, b) => a.value - b.value);
    const Q_TABLE = { 3: 0.970, 4: 0.829, 5: 0.710, 6: 0.625, 7: 0.568, 8: 0.526, 9: 0.493, 10: 0.466, 15: 0.338, 20: 0.298, 30: 0.239 };
    const qCrit = Q_TABLE[Object.keys(Q_TABLE).reverse().find(key => n >= parseInt(key)) || 3];
    const range = sortedData[n - 1].value - sortedData[0].value;
    if (range === 0) return [];
    const qLow = (sortedData[1].value - sortedData[0].value) / range;
    const qHigh = (sortedData[n - 1].value - sortedData[n - 2].value) / range;
    const outliers = [];
    if (qLow > qCrit) outliers.push(sortedData[0].index);
    if (qHigh > qCrit) outliers.push(sortedData[n-1].index);
    return outliers;
};
const findOutliersPeirce = (columnData) => findOutliersModifiedZScore(columnData, 4.0);
const methods = [
    { name: 'Interquartile Range (IQR)', fn: findOutliersIQR, description: 'Identifies outliers based on the spread of the middle 50% of the data.' },
    { name: 'Z-Score Method', fn: findOutliersZScore, description: 'Flags data points that deviate significantly from the mean (typically > 3 standard deviations).' },
    { name: 'Modified Z-Score Method', fn: findOutliersModifiedZScore, description: 'A robust version of Z-score using median and median absolute deviation, less sensitive to existing outliers.' },
    { name: 'Grubbs\' Test', fn: findOutliersGrubbs, description: 'A statistical test to detect a single outlier in a normally distributed univariate dataset. (Simplified)'},
    { name: 'Generalized ESD Test', fn: findOutliersESD, description: 'An iterative test to detect multiple outliers in a normally distributed dataset. (Simplified)'},
    { name: 'Dixon\'s Q Test', fn: findOutliersDixonQ, description: 'A test for single outliers in small datasets (n<30). (Simplified)'},
    { name: 'Peirce\'s Criterion', fn: findOutliersPeirce, description: 'An early, rigorous method for outlier rejection. (Conceptual proxy used)'}
];
const runAllAnalyses = (ds) => {
    return methods.map(method => {
        const outliers = new Map();
        for (let i = 0; i < ds.dimensions; i++) {
            const columnData = ds.data.map(dp => ({ value: dp.values[i], index: dp.index }));
            const outlierIndices = new Set(method.fn(columnData));
            outlierIndices.forEach(index => {
                const dataPoint = ds.data.find(dp => dp.index === index);
                if (dataPoint) {
                    // Use a composite key to avoid duplicates if a point is an outlier in multiple columns
                    const key = `${dataPoint.index}-${i}`;
                    if(!outliers.has(key)) {
                        outliers.set(key, {
                            index: dataPoint.index,
                            value: dataPoint.values[i],
                            point: dataPoint.values,
                            columnIndex: i
                        });
                    }
                }
            });
        }
        return { methodName: method.name, description: method.description, outliers: Array.from(outliers.values()) };
    });
};

// --- UI RENDERING & MANIPULATION ---
const updateUI = () => {
    // Update button state
    findOutliersBtn.disabled = isLoading || !dataSet;
    fileUploadInput.disabled = isLoading;
    fileUploadArea.classList.toggle('cursor-not-allowed', isLoading);
    fileUploadArea.classList.toggle('opacity-60', isLoading);

    if (isLoading) {
        findOutliersBtn.innerHTML = `
            <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Analyzing...`;
    } else {
        findOutliersBtn.textContent = 'Find Outliers';
    }

    // Show/hide analysis options
    if (dataSet) {
        analysisOptions.classList.remove('hidden');
        datasetDimensions.textContent = `${dataSet.dimensions}D`;
        datasetPoints.textContent = dataSet.data.length;
    } else {
        analysisOptions.classList.add('hidden');
    }

    // Show/hide plot toggle
    if (analysisResults && dataSet && dataSet.dimensions <= 2) {
        plotToggleContainer.classList.remove('hidden');
    } else {
        plotToggleContainer.classList.add('hidden');
    }
};

const renderResults = () => {
    if (!analysisResults) {
        resultsContainer.innerHTML = `
            <div class="bg-white h-full flex flex-col items-center justify-center p-8 rounded-lg shadow text-center">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-16 w-16 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V7a2 2 0 012-2h5l4 4v10a2 2 0 01-2 2z" />
                </svg>
                <h3 class="text-xl font-semibold text-gray-700">Analysis Results</h3>
                <p class="text-gray-500 mt-2">Results will be displayed here after you upload a file and run the analysis.</p>
            </div>`;
        return;
    }
    
    let contentHTML = '';
    const showPlot = showPlotCheckbox.checked && dataSet && dataSet.dimensions <= 2;
    
    if (showPlot) {
        contentHTML += `
            <div id="plot-container" class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-2xl font-bold mb-4">Data Visualization</h3>
                <div class="w-full overflow-x-auto">
                     <svg id="d3-plot" class="w-full" style="min-width: 500px;" viewBox="0 0 700 400" preserveAspectRatio="xMidYMid meet"></svg>
                </div>
            </div>`;
    }

    const reportHTML = `
        <div class="bg-white p-6 rounded-lg shadow">
            <h3 class="text-2xl font-bold mb-4">Analysis Report</h3>
            <div class="space-y-4">
                ${analysisResults.map((result, index) => `
                    <div class="border border-gray-200 rounded-lg overflow-hidden">
                        <button class="accordion-toggle w-full flex justify-between items-center p-4 bg-gray-50 hover:bg-gray-100 focus:outline-none" data-index="${index}">
                            <div class="text-left">
                                <h4 class="font-semibold text-lg text-gray-800">${result.methodName}</h4>
                                <p class="text-sm text-gray-500">${result.description}</p>
                            </div>
                            <div class="flex items-center">
                                <span class="mr-4 px-3 py-1 text-sm font-bold rounded-full ${result.outliers.length > 0 ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}">
                                    ${result.outliers.length} Outlier${result.outliers.length !== 1 ? 's' : ''}
                                </span>
                                <svg class="w-6 h-6 transform transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                            </div>
                        </button>
                        <div class="accordion-content hidden p-4 bg-white">
                            ${result.outliers.length > 0 ? `
                                <div class="overflow-x-auto">
                                    <table class="min-w-full divide-y divide-gray-200">
                                        <thead class="bg-gray-50">
                                            <tr>
                                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Index</th>
                                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Column</th>
                                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Outlier Value</th>
                                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Full Data Point</th>
                                            </tr>
                                        </thead>
                                        <tbody class="bg-white divide-y divide-gray-200">
                                            ${result.outliers.map(o => `
                                                <tr class="hover:bg-gray-50">
                                                    <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${o.index}</td>
                                                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${dataSet.headers[o.columnIndex] || `Column ${o.columnIndex + 1}`}</td>
                                                    <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold text-red-600">${o.value.toFixed(4)}</td>
                                                    <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">[${o.point.map(p => p.toFixed(2)).join(', ')}]</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            ` : `<p class="text-gray-600">No outliers were detected by this method.</p>`}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    
    resultsContainer.innerHTML = `<div class="space-y-6">${contentHTML}${reportHTML}</div>`;
    
    if (showPlot) {
        renderPlot();
    }
    
    // Add event listeners for new accordion toggles
    document.querySelectorAll('.accordion-toggle').forEach((button, index) => {
        button.addEventListener('click', () => {
            const content = button.nextElementSibling;
            const icon = button.querySelector('svg');
            const isOpening = content.classList.contains('hidden');

            // Close all others
            document.querySelectorAll('.accordion-content').forEach((el, i) => {
                if (i !== index) {
                    el.classList.add('hidden');
                    el.previousElementSibling.querySelector('svg').classList.remove('rotate-180');
                }
            });

            // Toggle current
            if (isOpening) {
                content.classList.remove('hidden');
                icon.classList.add('rotate-180');
            } else {
                content.classList.add('hidden');
                icon.classList.remove('rotate-180');
            }
        });

        // Open the first one by default
        if (index === 0) {
            button.click();
        }
    });
};

const renderPlot = () => {
    const d3Container = d3.select("#d3-plot");
    if (!dataSet || !d3Container.node()) return;

    const allOutliers = new Map();
    analysisResults.forEach(result => {
        result.outliers.forEach(outlier => {
            if (!allOutliers.has(outlier.index)) {
                allOutliers.set(outlier.index, outlier);
            }
        });
    });
    const uniqueOutlierIndices = new Set(allOutliers.keys());

    d3Container.selectAll("*").remove();

    const margin = { top: 40, right: 30, bottom: 50, left: 60 };
    const width = 700 - margin.left - margin.right;
    const height = 400 - margin.top - margin.bottom;

    const g = d3Container.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    
    const is1D = dataSet.dimensions === 1;
    const xData = is1D ? dataSet.data.map(d => d.index) : dataSet.data.map(d => d.values[0]);
    const yData = is1D ? dataSet.data.map(d => d.values[0]) : dataSet.data.map(d => d.values[1]);
    
    const [xMin, xMax] = d3.extent(xData);
    const [yMin, yMax] = d3.extent(yData);
    const xPadding = (xMax - xMin) * 0.05;
    const yPadding = (yMax - yMin) * 0.05;

    const xScale = d3.scaleLinear().domain([xMin - xPadding, xMax + xPadding]).range([0, width]);
    const yScale = d3.scaleLinear().domain([yMin - yPadding, yMax + yPadding]).range([height, 0]);

    g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(xScale));
    g.append("g").call(d3.axisLeft(yScale));
    g.append("text").attr("text-anchor", "middle").attr("x", width / 2).attr("y", height + margin.top).text(is1D ? "Index" : dataSet.headers[0] || "X-Axis");
    g.append("text").attr("text-anchor", "middle").attr("transform", "rotate(-90)").attr("y", -margin.left + 20).attr("x", -height / 2).text(is1D ? dataSet.headers[0] || "Value" : dataSet.headers[1] || "Y-Axis");
    d3Container.append("text").attr("x", 700 / 2).attr("y", margin.top - 10).attr("text-anchor", "middle").style("font-size", "16px").style("font-weight", "bold").text("Data Distribution with Outliers");

    const tooltip = d3.select("body").append("div").attr("class", "d3-tooltip");

    g.selectAll(".dot")
        .data(dataSet.data)
        .enter().append("circle")
        .attr("class", "dot")
        .attr("cx", d => xScale(is1D ? d.index : d.values[0]))
        .attr("cy", d => yScale(is1D ? d.values[0] : d.values[1]))
        .attr("r", 3.5)
        .style("fill", d => uniqueOutlierIndices.has(d.index) ? "#DC2626" : "#3B82F6")
        .on("mouseover", (event, d) => tooltip.style("visibility", "visible").text(`Index: ${d.index}, Point: [${d.values.map(v => v.toFixed(2)).join(', ')}]`))
        .on("mousemove", (event) => tooltip.style("top", (event.pageY-10)+"px").style("left",(event.pageX+10)+"px"))
        .on("mouseout", () => tooltip.style("visibility", "hidden"));

    g.selectAll(".outlier")
        .data(Array.from(allOutliers.values()))
        .enter().append("path")
        .attr("d", d3.symbol().type(d3.symbolTriangle).size(50))
        .attr("transform", d => `translate(${xScale(is1D ? d.index : d.point[0])}, ${yScale(is1D ? d.point[0] : d.point[1])})`)
        .style("fill", "#DC2626").style("stroke", "#fff").style("stroke-width", 1).style("pointer-events", "none");
    
    // This is a memory leak fix for the tooltip
    d3Container.on('remove', () => tooltip.remove());
};

const showError = (message) => {
    errorDisplay.textContent = message;
    errorDisplay.classList.remove('hidden');
};

// --- EVENT HANDLERS ---
const handleFileSelect = async (file) => {
    isLoading = true;
    errorDisplay.classList.add('hidden');
    analysisResults = null;
    dataSet = null;
    updateUI();
    renderResults();
    
    try {
        dataSet = await parseData(file);
    } catch (err) {
        showError(err.message || 'An unknown error occurred during file parsing.');
        dataSet = null;
    } finally {
        isLoading = false;
        updateUI();
    }
};

const handleFindOutliers = () => {
    if (!dataSet) {
        showError('Please upload a data set first.');
        return;
    }
    isLoading = true;
    errorDisplay.classList.add('hidden');
    analysisResults = null;
    updateUI();
    
    // Use setTimeout to allow UI to update before blocking for analysis
    setTimeout(() => {
        try {
            analysisResults = runAllAnalyses(dataSet);
        } catch (err) {
            showError(err.message || 'An unknown error occurred during analysis.');
            analysisResults = null;
        } finally {
            isLoading = false;
            updateUI();
            renderResults();
        }
    }, 50);
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // File upload via click
    fileUploadInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            handleFileSelect(e.target.files[0]);
        }
    });

    // File upload via drag & drop
    fileUploadArea.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); if(!isLoading) fileUploadArea.classList.add('border-blue-500', 'bg-blue-50'); });
    fileUploadArea.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); fileUploadArea.classList.remove('border-blue-500', 'bg-blue-50'); });
    fileUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    fileUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileUploadArea.classList.remove('border-blue-500', 'bg-blue-50');
        if (isLoading) return;
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            handleFileSelect(files[0]);
        }
    });
    
    // Find outliers button
    findOutliersBtn.addEventListener('click', handleFindOutliers);

    // Plot checkbox
    showPlotCheckbox.addEventListener('change', () => {
        if (analysisResults) {
            renderResults();
        }
    });

    updateUI();
});
