import React, { useState, useEffect } from 'react';
import packageJson from '../package.json';
import { 
  Activity, 
  Database, 
  FileText, 
  Play, 
  Trash2, 
  BarChart2, 
  Download, 
  Upload as UploadCloud, 
  Sparkles, 
  X,
  Key,
  HelpCircle,
  Cloud
} from 'lucide-react';
import { 
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Scatter, ReferenceArea, Area, ReferenceLine
} from 'recharts';

import { processCSV } from './lib/duckdb';
import { analyzeTimeSeries } from './lib/transformers';
import { getBackendUrl } from './lib/backend';
import t from './lib/i18n';
import './index.css';

const HelpTooltip = ({ text }: { text: string }) => (
  <span className="tooltip-container">
    <HelpCircle className="w-3 h-3" />
    <span className="tooltip-text">{text}</span>
  </span>
);

// Removed local getBackendUrl to use centralized version from ./lib/backend

interface DataPoint {
  index: number | string;
  value: number;
  is_anomaly?: boolean;
  low?: number;
  high?: number;
  counterfactual?: number;
  event_name?: string;
  is_prediction?: boolean;
}

function App() {
  const [data, setData] = useState<DataPoint[]>([]);
  const [pastedText, setPastedText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState(t.statusIdle);
  const [activeTab, setActiveTab] = useState<'upload' | 'paste' | 'gcs' | 'bigquery'>('paste');
  const [gsUrl, setGsUrl] = useState('');
  const [bqProject, setBqProject] = useState('');
  const [bqQuery, setBqQuery] = useState('SELECT *\nFROM `bigquery-public-data.covid19_open_data.covid19_open_data`\nLIMIT 100');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  // Data columns state
  const [rawRows, setRawRows] = useState<any[]>([]);
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const [selectedTimeCol, setSelectedTimeCol] = useState<string>('');
  const [selectedValueCol, setSelectedValueCol] = useState<string>('');
  const [selectedEventCol, setSelectedEventCol] = useState<string>('');
  
  // Selection & Timezone states
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [refAreaLeft, setRefAreaLeft] = useState<number | string | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<number | string | null>(null);
  const [selectionRange, setSelectionRange] = useState<[number, number] | null>(null);
  const [isCounterfactualLoading, setIsCounterfactualLoading] = useState(false);
  const [eventNameInput, setEventNameInput] = useState('');
  const [eventStartInput, setEventStartInput] = useState('');
  const [eventEndInput, setEventEndInput] = useState('');
  const [sensitivity, setSensitivity] = useState(2.5);
  const [forecastLength, setForecastLength] = useState(24);
  const [anomalyMinCtx, setAnomalyMinCtx] = useState(16);
  const [anomalyWidthMultiplier, setAnomalyWidthMultiplier] = useState(0.5);
  const [contextMultiple, setContextMultiple] = useState(32);
  const [effectiveHorizon, setEffectiveHorizon] = useState(128);
  
  // Zoom state
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  
  const [backendStatus, setBackendStatus] = useState<{status: string, message: string, model_id?: string}>({status: 'idle', message: t.statusCheckingBackend});

  useEffect(() => {
    document.title = `TimesFM Sandbox v${packageJson.version}`;
    
    // Poll backend status
    const checkStatus = async () => {
      try {
        const baseUrl = await getBackendUrl();
        const res = await fetch(`${baseUrl}/status`);
        const data = await res.json();
        setBackendStatus(prev => {
          // If status just changed from loading to ready, and we have data, we might want to trigger re-analysis
          if (prev.status === 'loading' && data.status === 'ready') {
            console.log("Model is now ready, triggering re-analysis if data exists...");
          }
          return data;
        });
      } catch (e) {
        setBackendStatus({status: 'error', message: t.statusBackendUnreachable});
      }
    };
    
    checkStatus();
    const timer = setInterval(checkStatus, 2000);
    return () => clearInterval(timer);
  }, []);

  // Debounced re-analysis for all parameter changes
  useEffect(() => {
    if (!backendStatus.status || backendStatus.status !== 'ready') return;
    if (rawRows.length === 0 || !selectedValueCol) return;

    const handler = setTimeout(() => {
      runAnalysis(rawRows, selectedTimeCol, selectedValueCol, selectedEventCol, sensitivity, forecastLength, anomalyMinCtx, anomalyWidthMultiplier, contextMultiple, effectiveHorizon);
    }, 500);

    return () => clearTimeout(handler);
  }, [sensitivity, forecastLength, anomalyMinCtx, anomalyWidthMultiplier, contextMultiple, effectiveHorizon, selectedTimeCol, selectedValueCol, selectedEventCol, rawRows, backendStatus.status]);
  
  const runAnalysis = async (rows: any[], timeCol: string, valCol: string, eventCol: string = '', currentSensitivity: number = sensitivity, currentHorizon: number = forecastLength, currentMinCtx: number = anomalyMinCtx, currentWidthMult: number = anomalyWidthMultiplier, currentCtxMult: number = contextMultiple, currentEffHorizon: number = effectiveHorizon) => {
    try {
      if (!valCol || !rows || rows.length === 0) return;
      
      setIsProcessing(true);
      setStatus(t.statusDetectingAnomalies);
      
      const chartData: DataPoint[] = rows.map((row, i) => {
        let event_name = undefined;
        if (eventCol && row[eventCol] !== undefined && row[eventCol] !== null && row[eventCol] !== '') {
          event_name = String(row[eventCol]).trim();
        }
        return {
          index: (timeCol && row[timeCol] !== undefined) ? row[timeCol] : (row._index ?? i),
          value: Number(row[valCol]),
          is_anomaly: false,
          event_name
        };
      });
      
      // Extract covariates (Xreg) from events
      // 1. Map current indices to event presence
      const eventMap = new Map<string | number, boolean>();
      chartData.forEach(d => {
        if (d.event_name) eventMap.set(d.index, true);
      });
      
      // 2. Build covariate array for [History + Horizon]
      const covariates: number[] = [];
      
      // Past
      chartData.forEach((d) => {
        const hasEvent = d.event_name || eventMap.get(d.index);
        covariates.push(hasEvent ? 1.0 : 0.0);
      });
      
      // Future
      const lastPointForInterval = chartData[chartData.length - 1];
      const prevPointForInterval = chartData[chartData.length - 2];
      let intervalForCov = 1;
      let lastIndexForCov = lastPointForInterval ? Number(lastPointForInterval.index) : 0;
      
      if (lastPointForInterval && prevPointForInterval) {
        const lastV = Number(lastPointForInterval.index);
        const prevV = Number(prevPointForInterval.index);
        if (!isNaN(lastV) && !isNaN(prevV) && lastV !== prevV) intervalForCov = lastV - prevV;
      }
      
      for (let i = 1; i <= currentHorizon; i++) {
        const futureIdx = isNaN(lastIndexForCov) ? `Pred ${i}` : lastIndexForCov + (intervalForCov * i);
        covariates.push(eventMap.get(futureIdx) ? 1.0 : 0.0);
      }
      
      setData(chartData);
      
      const valuesArray = chartData.map(d => d.value).filter(v => !isNaN(v));
      
      const { forecast, anomalies, low, high } = await analyzeTimeSeries(valuesArray, currentHorizon, undefined, currentSensitivity, covariates, currentMinCtx, currentWidthMult, currentCtxMult, currentEffHorizon);
      
      const chartDataWithAnomalies = chartData.map((item, idx) => ({
        ...item,
        is_anomaly: anomalies.includes(idx)
      }));
      
      const lastPoint = chartDataWithAnomalies[chartDataWithAnomalies.length - 1];
      const prevPoint = chartDataWithAnomalies[chartDataWithAnomalies.length - 2];
      
      let lastIndexNum = lastPoint ? Number(lastPoint.index) : 0;
      let interval = 1;
      
      if (lastPoint && prevPoint) {
        const lastVal = Number(lastPoint.index);
        const prevVal = Number(prevPoint.index);
        if (!isNaN(lastVal) && !isNaN(prevVal) && lastVal !== prevVal) {
          interval = lastVal - prevVal;
        }
      }
      
      const predictionData: DataPoint[] = forecast.map((val, i) => ({
        index: isNaN(lastIndexNum) ? `Pred ${i+1}` : lastIndexNum + (interval * (i + 1)),
        value: val,
        is_prediction: true,
        low: low ? low[i] : undefined,
        high: high ? high[i] : undefined,
      }));
      
      setData([...chartDataWithAnomalies, ...predictionData]);
      setStatus(t.statusComplete);
      setSelectionRange(null);
      
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${(error as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const resetData = () => {
    setRawRows([]);
    setAvailableColumns([]);
    setData([]);
    setSelectedTimeCol('');
    setSelectedValueCol('');
    setSelectedEventCol('');
    setSelectionRange(null);
    setZoomRange(null);
    setStatus(t.statusIdle);
    setPastedText('');
    setIsProcessing(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    // Only zoom if we have data
    if (data.length < 5) return;
    
    // Alt + Scroll or just Scroll? Let's use standard Scroll but check if it's horizontal or vertical
    // On many laptops, deltaY is zoom-like for wheel.
    if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
    
    e.preventDefault();
    
    const currentRange = zoomRange || [0, data.length - 1];
    const rangeLength = currentRange[1] - currentRange[0];

    // Handle Horizontal Pan
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const panFactor = 0.5;
      const move = Math.round(e.deltaX * (rangeLength / 500) * panFactor);
      if (move === 0) return;
      
      let newStart = currentRange[0] + move;
      let newEnd = currentRange[1] + move;
      
      if (newStart < 0) {
        newStart = 0;
        newEnd = rangeLength;
      }
      if (newEnd > data.length - 1) {
        newEnd = data.length - 1;
        newStart = newEnd - rangeLength;
      }
      
      setZoomRange([newStart, newEnd]);
      return;
    }
    
    // Handle Zoom (deltaY)
    const zoomFactor = 0.1;
    const direction = e.deltaY > 0 ? 1 : -1; // 1 = Zoom Out, -1 = Zoom In
    
    // Zoom centered on hovered index or middle if not hovered
    const targetIdx = hoveredIndex !== null ? hoveredIndex : (currentRange[0] + rangeLength / 2);
    
    // Relative position of target in current view (0 to 1)
    const relPos = (targetIdx - currentRange[0]) / (rangeLength || 1);
    
    let newRangeLength = rangeLength * (1 + direction * zoomFactor);
    
    // Constraints
    if (newRangeLength < 5) newRangeLength = 5;
    if (newRangeLength > data.length - 1) {
      setZoomRange(null);
      return;
    }
    
    // Calculate new start/end based on relative position
    let newStart = targetIdx - newRangeLength * relPos;
    let newEnd = newStart + newRangeLength;
    
    // Correct bounds
    if (newStart < 0) {
      newStart = 0;
      newEnd = newRangeLength;
    }
    if (newEnd > data.length - 1) {
      newEnd = data.length - 1;
      newStart = newEnd - newRangeLength;
    }
    
    setZoomRange([Math.round(newStart), Math.round(newEnd)]);
  };

  const handleDataInput = async (content: string) => {
    try {
      setIsProcessing(true);
      setStatus(t.statusLoadDuckDB);
      
      const newRows = await processCSV(`input_${Date.now()}.csv`, content);
      
      if (newRows.length === 0) {
        throw new Error("No data found");
      }
      
      const newKeys = Object.keys(newRows[0]).filter(k => k !== '_index');
      
      let combinedRows = newRows;
      let updatedColumns = newKeys;
      
      // Auto-select columns
      const timeColToUse = updatedColumns.length > 1 ? updatedColumns[0] : '';
      const valColToUse = updatedColumns.length > 1 ? updatedColumns[1] : updatedColumns[0];
      const eventColToUse = '';
      
      setAvailableColumns(updatedColumns);
      setRawRows(combinedRows);
      setSelectedTimeCol(timeColToUse);
      setSelectedValueCol(valColToUse);
      setSelectedEventCol(eventColToUse);
      
      setStatus(t.statusSettingUpData);
      // No need to call runAnalysis here, the useEffect will trigger it 
      // when rawRows, selectedTimeCol, and selectedValueCol are set.
      
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${(error as Error).message}`);
      setIsProcessing(false);
    }
  };

  const runCounterfactual = async () => {
    if (!selectionRange || data.length === 0) return;
    
    try {
      setIsCounterfactualLoading(true);
      setStatus(t.statusRunningCounterfactual);
      
      const observedData = data.filter(d => !d.is_prediction);
      const valuesArray = observedData.map(d => d.value);
      
      const { counterfactual } = await analyzeTimeSeries(
        valuesArray, 
        forecastLength, 
        selectionRange,
        sensitivity,
        undefined,
        anomalyMinCtx,
        anomalyWidthMultiplier,
        contextMultiple,
        effectiveHorizon
      );
      
      if (counterfactual) {
        const newData = [...data];
        const startIdx = selectionRange[0];
        
        const updatedData = newData.map((item, idx) => {
          const cfIdx = idx - startIdx;
          if (cfIdx >= 0 && cfIdx < counterfactual.length) {
            return { ...item, counterfactual: counterfactual[cfIdx] };
          }
          return item;
        });
        
        setData(updatedData);
        setStatus(t.statusCounterfactualComplete);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${(error as Error).message}`);
    } finally {
      setIsCounterfactualLoading(false);
    }
  };

  const clearCounterfactual = () => {
    setData(prevData => prevData.map(item => {
      const { counterfactual, ...rest } = item;
      return rest;
    }));
    setStatus(t.statusCounterfactualReset);
  };

  const formatTime = (time: any): string => {
    if (time === null || time === undefined) return '';
    
    let dateInput: any = time;
    
    if (typeof time === 'number') {
      const t = time;
      if (t > 1e14) {
        dateInput = t / 1000;
      } else if (t > 1e11) {
        dateInput = t;
      } else if (t > 1e8) {
        dateInput = t * 1000;
      } else {
        return time.toString();
      }
    }
    
    try {
      const date = new Date(dateInput);
      if (isNaN(date.getTime())) return String(time);
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch {
      return String(time);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      handleDataInput(text);
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset so the same file can be re-uploaded
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      handleDataInput(text);
    };
    reader.readAsText(file);
  };

  const processPastedData = () => {
    if (!pastedText.trim()) return;
    handleDataInput(pastedText);
  };

  const exportToCSV = () => {
    if (data.length === 0) return;
    
    let csvContent = "TimeIndex,Value,IsAnomaly,IsPrediction,Low,High,EventName\n";
    
    data.forEach((row) => {
      const isAnomaly = row.is_anomaly ? 'TRUE' : 'FALSE';
      const isPrediction = row.is_prediction ? 'TRUE' : 'FALSE';
      const low = row.low !== undefined ? row.low : '';
      const high = row.high !== undefined ? row.high : '';
      const eventName = row.event_name ? `"${row.event_name.replace(/"/g, '""')}"` : '';
      csvContent += `${row.index},${row.value},${isAnomaly},${isPrediction},${low},${high},${eventName}\n`;
    });
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "timesfm_analysis_results.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleGCPAuth = async () => {
    try {
      setStatus(t.statusWaitAuth);
      const baseUrl = await getBackendUrl();
      const response = await fetch(`${baseUrl}/gcp/auth`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Auth failed');
      setIsAuthenticated(true);
      setStatus(t.statusAuthSuccess);
    } catch (e: any) {
      alert(`Authentication failed: ${e.message}\n(Ensure client_secret.json is in the project root)`);
      setStatus(t.statusAuthFailed);
    }
  };

  const fetchGCSData = async () => {
    if (!gsUrl.trim()) return;
    try {
      setIsProcessing(true);
      setStatus(t.statusGCSLoading);
      const baseUrl = await getBackendUrl();
      const response = await fetch(`${baseUrl}/gcp/gcs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gs_url: gsUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail);
      handleDataInput(data.csv);
    } catch (e: any) {
      alert(`GCS Error: ${e.message}`);
      setStatus(t.statusGCSFailed);
      setIsProcessing(false);
    }
  };

  const fetchBQData = async () => {
    if (!bqProject.trim() || !bqQuery.trim()) return;
    try {
      setIsProcessing(true);
      setStatus(t.statusBQExecuting);
      const baseUrl = await getBackendUrl();
      const response = await fetch(`${baseUrl}/gcp/bigquery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: bqProject, query: bqQuery })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail);
      handleDataInput(data.csv);
    } catch (e: any) {
      alert(`BigQuery Error: ${e.message}`);
      setStatus(t.statusBQFailed);
      setIsProcessing(false);
    }
  };

  const handleChartMouseDown = (e: any) => {
    if (e && e.activeTooltipIndex !== undefined) {
      const indexInVisible = e.activeTooltipIndex;
      const actualIndex = zoomRange ? zoomRange[0] + indexInVisible : indexInVisible;
      setRefAreaLeft(actualIndex);
    }
  };

  const handleChartMouseMove = (e: any) => {
    if (e && e.activeTooltipIndex !== undefined) {
      // Map activeTooltipIndex from visibleData back to the original data index if we're zoomed
      const indexInVisible = e.activeTooltipIndex;
      const actualIndex = zoomRange ? zoomRange[0] + indexInVisible : indexInVisible;
      setHoveredIndex(actualIndex);
      
      if (refAreaLeft !== null) {
        setRefAreaRight(actualIndex);
      }
    }
  };

  const handleChartMouseUp = () => {
    if (refAreaLeft !== null) {
      const left = Number(refAreaLeft);
      const right = refAreaRight !== null ? Number(refAreaRight) : left;
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      
      const observedCount = data.filter(d => !d.is_prediction).length;
      if (start < observedCount) {
        setSelectionRange([start, Math.min(end, observedCount - 1)]);
      }
    }
    setRefAreaLeft(null);
    setRefAreaRight(null);
  };

  // Group events for charting
  const eventAreas: { name: string, start: any, end: any }[] = [];
  let currentEvent: { name: string, start: any, end: any } | null = null;
  
  data.forEach((d) => {
    if (d.event_name) {
      if (!currentEvent || currentEvent.name !== d.event_name) {
        if (currentEvent) eventAreas.push(currentEvent);
        currentEvent = { name: d.event_name, start: d.index, end: d.index };
      } else {
        currentEvent.end = d.index;
      }
    } else {
      if (currentEvent) {
        eventAreas.push(currentEvent);
        currentEvent = null;
      }
    }
  });
  if (currentEvent) eventAreas.push(currentEvent);

  // Process data for the chart
  const chartSlice = zoomRange ? data.slice(zoomRange[0], zoomRange[1] + 1) : data;
  const processedChartData = chartSlice.map((d, i) => {
    // We need to check against the full data to know if it's the last observed
    // Find actual index in original data
    const actualIdx = zoomRange ? zoomRange[0] + i : i;
    const isLastObserved = !d.is_prediction && data[actualIdx + 1]?.is_prediction;
    return {
      ...d,
      actual_value: !d.is_prediction ? d.value : null,
      predicted_value: d.is_prediction ? d.value : (isLastObserved ? d.value : null),
      anomaly_value: d.is_anomaly ? d.value : null,
      pred_interval: d.is_prediction && d.low !== undefined && d.high !== undefined 
        ? [d.low, d.high] 
        : (isLastObserved ? [d.value, d.value] : null)
    };
  });

  return (
    <div className="app-container">
      <header>
        <h1>
          <Activity className="w-8 h-8 text-primary" /> 
          {t.title} 
          <span className="text-sm text-slate-500 font-medium ml-2 relative top-1">v{packageJson.version}</span>
        </h1>
        <div className="flex items-center gap-4">
          {backendStatus.status !== 'ready' && (
            <div className={`status-badge ${backendStatus.status === 'loading' ? 'processing' : 'error'}`}>
              <div className="status-indicator"></div>
              {backendStatus.message}
            </div>
          )}
          <div className={`status-badge ${isProcessing ? 'processing' : status === 'Complete' ? 'active' : ''}`}>
            <div className="status-indicator"></div>
            {status}
          </div>
        </div>
      </header>
      
      <div className="main-grid">
        <aside className="side-panel">
          <div className="glass-card input-section fade-in">
            <h2><FileText className="w-5 h-5" /> {t.sectionDataSource}</h2>
            
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'paste' ? 'active' : ''}`}
                onClick={() => setActiveTab('paste')}
              >
                {t.tabPaste}
              </button>
              <button 
                className={`tab ${activeTab === 'upload' ? 'active' : ''}`}
                onClick={() => setActiveTab('upload')}
              >
                {t.tabFile}
              </button>
              <button 
                className={`tab ${activeTab === 'gcs' ? 'active' : ''}`}
                onClick={() => setActiveTab('gcs')}
              >
                {t.tabGCS}
              </button>
              <button 
                className={`tab ${activeTab === 'bigquery' ? 'active' : ''}`}
                onClick={() => setActiveTab('bigquery')}
              >
                {t.tabBQ}
              </button>
            </div>
            
            {!isAuthenticated && (activeTab === 'gcs' || activeTab === 'bigquery') && (
              <div className="p-4 mb-4 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
                <p className="mb-3 text-[#cbd5e1]">{t.msgRequireAuth}</p>
                <button className="btn w-full bg-blue-600 hover:bg-blue-500 flex justify-center items-center gap-2" onClick={handleGCPAuth}>
                  <Key className="w-4 h-4" /> {t.btnAuthenticate}
                </button>
              </div>
            )}

            {activeTab === 'paste' ? (
              <>
                <textarea 
                  placeholder={t.placeholderPaste}
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                />
                <button 
                  className="btn btn-primary" 
                  onClick={processPastedData}
                  disabled={isProcessing || !pastedText.trim()}
                >
                  <Play className="w-4 h-4" /> {t.btnAnalyzeData}
                </button>
              </>
            ) : activeTab === 'gcs' ? (
              <div className="flex flex-col gap-3 fade-in">
                <div className="flex items-center gap-2 mb-2 text-[#94a3b8]">
                  <Cloud className="w-5 h-5" /> Load CSV from GCS
                </div>
                <input 
                  type="text" 
                  className="w-full p-3 bg-slate-900 border border-slate-700 rounded-md text-slate-200" 
                  placeholder={t.placeholderGCS}
                  value={gsUrl}
                  onChange={(e) => setGsUrl(e.target.value)}
                  disabled={!isAuthenticated}
                />
                <button 
                  className="btn btn-primary mt-2" 
                  onClick={fetchGCSData}
                  disabled={isProcessing || !gsUrl.trim() || !isAuthenticated}
                >
                  <Play className="w-4 h-4" /> {t.btnLoadAnalyze}
                </button>
              </div>
            ) : activeTab === 'bigquery' ? (
              <div className="flex flex-col gap-3 fade-in">
                <div className="flex items-center gap-2 mb-2 text-[#94a3b8]">
                  <Database className="w-5 h-5" /> Query BigQuery
                </div>
                <input 
                  type="text" 
                  className="w-full p-3 bg-slate-900 border border-slate-700 rounded-md text-slate-200" 
                  placeholder={t.placeholderBQProject}
                  value={bqProject}
                  onChange={(e) => setBqProject(e.target.value)}
                  disabled={!isAuthenticated}
                />
                <textarea 
                  className="w-full p-3 bg-slate-900 border border-slate-700 rounded-md text-slate-200 min-h-[120px] font-mono text-xs" 
                  value={bqQuery}
                  onChange={(e) => setBqQuery(e.target.value)}
                  disabled={!isAuthenticated}
                />
                <button 
                  className="btn btn-primary mt-2" 
                  onClick={fetchBQData}
                  disabled={isProcessing || !bqProject.trim() || !bqQuery.trim() || !isAuthenticated}
                >
                  <Play className="w-4 h-4" /> {t.btnRunQueryAnalyze}
                </button>
              </div>
            ) : (
              <div 
                className="file-drop-area"
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => document.getElementById('file-upload')?.click()}
              >
                <input 
                  type="file" 
                  id="file-upload" 
                  className="hidden" 
                  style={{ display: 'none' }}
                  accept=".csv,.tsv,.txt"
                  onChange={handleFileUpload}
                />
                <UploadCloud className="w-10 h-10 file-drop-icon mx-auto" />
                <p>Click or drag file to upload</p>
                <p className="subtitle">CSV, TSV files supported</p>
              </div>
            )}
            
            {availableColumns.length > 0 && (
              <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 fade-in">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Database className="w-4 h-4 text-accent" /> {t.sectionColumnMapping}</h3>
                
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">{t.labelTimeAxis}</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200"
                      value={selectedTimeCol}
                      onChange={(e) => {
                        setSelectedTimeCol(e.target.value);
                      }}
                      disabled={isProcessing}
                    >
                      <option value="">{t.msgAutoIndex}</option>
                      {availableColumns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">{t.labelValueAxis}</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200"
                      value={selectedValueCol}
                      onChange={(e) => {
                        setSelectedValueCol(e.target.value);
                      }}
                      disabled={isProcessing}
                    >
                      {availableColumns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">{t.labelEventColumn}</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200"
                      value={selectedEventCol}
                      onChange={(e) => {
                        setSelectedEventCol(e.target.value);
                      }}
                      disabled={isProcessing}
                    >
                      <option value="">{t.msgNone}</option>
                      {availableColumns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}
            
            {data.length > 0 && (
              <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 fade-in">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-500" /> {t.sectionManualEvent}
                  <HelpTooltip text={t.helpEventLabeling} />
                </h3>

                <div className="flex flex-col gap-2 p-3 bg-slate-900 rounded border border-slate-700">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t.labelStartTime}</label>
                      <select 
                        className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500"
                        value={eventStartInput}
                        onChange={(e) => setEventStartInput(e.target.value)}
                      >
                        <option value="">{t.msgSelectStart}</option>
                        {data.map((d, i) => (
                           <option key={`start-${i}`} value={String(d.index)}>{formatTime(d.index)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t.labelEndTime}</label>
                      <select 
                        className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500"
                        value={eventEndInput}
                        onChange={(e) => setEventEndInput(e.target.value)}
                      >
                        <option value="">{t.msgSameAsStart}</option>
                        {data.map((d, i) => (
                           <option key={`end-${i}`} value={String(d.index)}>{formatTime(d.index)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">{t.labelEventName}</label>
                    <input 
                      type="text" 
                      className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500"
                      placeholder={t.placeholderEventName}
                      value={eventNameInput}
                      onChange={(e) => setEventNameInput(e.target.value)}
                    />
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button 
                      className="flex-1 btn text-xs py-1 px-2 bg-amber-600 hover:bg-amber-500 text-white flex justify-center items-center"
                      onClick={() => {
                        const startStr = eventStartInput.trim();
                        if (!startStr || !eventNameInput.trim()) return;
                        
                        const endStr = eventEndInput.trim() || startStr;
                        const startIdx = data.findIndex(d => String(d.index) === startStr);
                        const endIdx = data.findIndex(d => String(d.index) === endStr);
                        
                        if (startIdx === -1) {
                          alert(`Index "${startStr}" not found in data.`);
                          return;
                        }
                        
                        const actualStart = endIdx !== -1 ? Math.min(startIdx, endIdx) : startIdx;
                        const actualEnd = endIdx !== -1 ? Math.max(startIdx, endIdx) : startIdx;
                        
                        setData(prev => prev.map((d, i) => {
                          if (i >= actualStart && i <= actualEnd) {
                            return { ...d, event_name: eventNameInput.trim() };
                          }
                          return d;
                        }));
                      }}
                      disabled={!eventNameInput.trim() || !eventStartInput.trim()}
                    >
                      {t.btnSetEvent}
                    </button>
                    <button 
                      className="flex-1 btn text-xs py-1 px-2 bg-slate-700 hover:bg-slate-600 text-slate-300 flex justify-center items-center"
                      onClick={() => {
                        const startStr = eventStartInput.trim();
                        if (!startStr) return;
                        
                        const endStr = eventEndInput.trim() || startStr;
                        const startIdx = data.findIndex(d => String(d.index) === startStr);
                        const endIdx = data.findIndex(d => String(d.index) === endStr);
                        
                        if (startIdx === -1) return;
                        const actualStart = endIdx !== -1 ? Math.min(startIdx, endIdx) : startIdx;
                        const actualEnd = endIdx !== -1 ? Math.max(startIdx, endIdx) : startIdx;
                        
                        setData(prev => prev.map((d, i) => {
                          if (i >= actualStart && i <= actualEnd) {
                            const { event_name, ...rest } = d;
                            return rest;
                          }
                          return d;
                        }));
                      }}
                      disabled={!eventStartInput.trim()}
                    >
                      {t.btnClearTargetEvent}
                    </button>
                  </div>
                </div>
              </div>
            )}
            
            {rawRows.length > 0 && (
              <button 
                className="btn w-full mt-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 flex justify-center items-center gap-2"
                onClick={resetData}
                disabled={isProcessing}
              >
                <Trash2 className="w-4 h-4" /> {t.btnResetAllData}
              </button>
            )}
            
            <div className="mt-4 text-xs text-[#94a3b8] p-3 rounded bg-[rgba(0,0,0,0.2)] border border-[#334155]">
              <div className="flex items-center justify-between mb-2">
                <p className="font-semibold flex items-center gap-1"><Sparkles className="w-3 h-3" /> Active Model:</p>
                {backendStatus.status === 'loading' && <div className="loading-spinner-tiny"></div>}
              </div>
              
              <select 
                className="w-full mb-3 p-2 bg-slate-900 border border-slate-700 rounded text-[10px] font-mono focus:outline-none focus:border-primary transition-colors"
                value={backendStatus.model_id}
                disabled={backendStatus.status === 'loading'}
                onChange={async (e) => {
                  try {
                    const modelId = e.target.value;
                    setBackendStatus(prev => ({ ...prev, status: 'loading', message: `${t.msgModelSwitching} ${modelId}...` }));
                    const baseUrl = await getBackendUrl();
                    await fetch(`${baseUrl}/init_model?model_id=${encodeURIComponent(modelId)}`, { method: 'POST' });
                  } catch (err) {
                    console.error("Failed to switch model:", err);
                  }
                }}
              >
                <option value="google/timesfm-2.5-200m-pytorch">TimesFM 2.5 (200M)</option>
              </select>

              <p className="font-semibold mb-1 flex items-center gap-1">Powered by:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>DuckDB WASM (Data Processing)</li>
                <li>TimesFM Python Backend</li>
              </ul>

              <div className="mt-4 pt-4 border-t border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-amber-500" /> {t.sectionAnomalySensitivity}
                    <HelpTooltip text={t.helpSensitivity} />
                  </p>
                  <span className="text-[10px] text-amber-500 font-mono font-bold">{sensitivity.toFixed(1)}σ</span>
                </div>
                <input 
                  type="range" 
                  min="1.0" 
                  max="5.0" 
                  step="0.1" 
                  className="w-full accent-amber-500 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                  value={sensitivity}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setSensitivity(val);
                  }}
                />
                <div className="flex justify-between mt-1 text-[8px] text-slate-500 font-mono">
                  <span>SENSITIVE</span>
                  <span>NORMAL(2.5)</span>
                  <span>STRICT</span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold flex items-center gap-1">
                    <BarChart2 className="w-3 h-3 text-primary" /> {t.sectionForecastHorizon}
                    <HelpTooltip text={t.helpHorizon} />
                  </p>
                  <span className="text-[10px] text-primary font-mono font-bold">{forecastLength} points</span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max="256" 
                  step="1" 
                  className="w-full accent-primary h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                  value={forecastLength}
                  onChange={(e) => {
                    setForecastLength(parseInt(e.target.value));
                  }}
                />
                <div className="flex justify-between mt-1 text-[8px] text-slate-500 font-mono">
                  <span>SHORT</span>
                  <span>MEDIUM(24-128)</span>
                  <span>LONG(256)</span>
                </div>
              </div>

              {/* Advanced Parameters */}
              <details className="mt-4 pt-4 border-t border-slate-700 group">
                <summary className="text-xs font-semibold text-slate-400 cursor-pointer hover:text-slate-200 flex items-center justify-between list-none">
                  <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> {t.sectionAdvancedParams}</span>
                  <span className="group-open:rotate-180 transition-transform">▼</span>
                </summary>

                <div className="mt-4 space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] font-semibold text-slate-400">
                        {t.labelAnomalyStart}
                        <HelpTooltip text={t.helpMinCtx} />
                      </p>
                      <span className="text-[10px] text-slate-300 font-mono">{anomalyMinCtx}</span>
                    </div>

                    <input 
                      type="range" 
                      min="1" 
                      max="128" 
                      step="1" 
                      className="w-full accent-slate-400 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                      value={anomalyMinCtx}
                      onChange={(e) => setAnomalyMinCtx(parseInt(e.target.value))}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] font-semibold text-slate-400">
                        {t.labelUncertaintyFloor}
                        <HelpTooltip text={t.helpWidthMult} />
                      </p>
                      <span className="text-[10px] text-slate-300 font-mono">{anomalyWidthMultiplier.toFixed(2)}</span>
                    </div>

                    <input 
                      type="range" 
                      min="0.0" 
                      max="2.0" 
                      step="0.05" 
                      className="w-full accent-slate-400 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                      value={anomalyWidthMultiplier}
                      onChange={(e) => setAnomalyWidthMultiplier(parseFloat(e.target.value))}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">
                        {t.labelContextMultiple}
                        <HelpTooltip text={t.helpCtxMult} />
                      </label>
                      <select 
                        className="w-full bg-slate-900 border border-slate-700 rounded p-1 text-[10px] text-slate-200"
                        value={contextMultiple}
                        onChange={(e) => setContextMultiple(parseInt(e.target.value))}
                      >
                        <option value="1">1 ({t.msgNone})</option>
                        <option value="8">8</option>
                        <option value="16">16</option>
                        <option value="32">32 (Default)</option>
                        <option value="64">64</option>

                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">
                        {t.labelMaxHorizon}
                        <HelpTooltip text={t.helpMaxHorizon} />
                      </label>
                      <select 
                        className="w-full bg-slate-900 border border-slate-700 rounded p-1 text-[10px] text-slate-200"
                        value={effectiveHorizon}
                        onChange={(e) => setEffectiveHorizon(parseInt(e.target.value))}
                      >
                        <option value="64">64</option>
                        <option value="128">128 (Default)</option>
                        <option value="256">256</option>
                        <option value="512">512</option>
                      </select>
                    </div>
                  </div>

                </div>
              </details>
            </div>
          </div>
        </aside>
        
        <main className="glass-card chart-container fade-in" style={{ animationDelay: '0.1s' }}>
          <div className="chart-header">
            <h2 className="chart-title flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-accent" />
              {t.sectionAnalysisResults}
            </h2>
            <div className="flex gap-2">
              {data.some(d => d.counterfactual !== undefined) && (
                <button 
                  className="btn text-sm px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 flex items-center gap-2" 
                  onClick={clearCounterfactual}
                >
                  <X className="w-4 h-4" /> {t.btnClearEffect}
                </button>
              )}
              {data.length > 0 && (
                <>
                  {zoomRange && (
                    <button className="btn text-sm px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 flex items-center gap-2" onClick={() => setZoomRange(null)}>
                      {t.btnResetZoom}
                    </button>
                  )}
                  <button className="btn text-sm px-3 py-1.5 bg-[rgba(255,255,255,0.1)] hover:bg-[rgba(255,255,255,0.2)] border border-[#334155] flex items-center gap-2" onClick={exportToCSV}>
                    <Download className="w-4 h-4" /> {t.btnExportCSV}
                  </button>
                </>
              )}
            </div>

          </div>
          
          {data.length > 0 ? (
            <div className="w-full flex flex-col flex-1 relative" style={{ minHeight: 0 }}>
              {/* Inference Overlay */}
              <div className={`inference-overlay ${!(isProcessing || isCounterfactualLoading) ? 'hidden' : ''}`}>
                <div className="ai-visual-container">
                  <div className="ai-pulse-ring">
                    <div className="ai-core"></div>
                  </div>
                  <div className="inference-text">{t.msgInferenceInProgress}</div>
                  <div className="scanning-container">
                    <div className="scanning-bar"></div>
                  </div>
                  <div className="inference-subtext">{status}</div>
                </div>
              </div>

              <div className="flex justify-between items-center mb-4 shrink-0">
                <div className="flex gap-4 items-center">
                  <div className="text-sm font-medium text-slate-400">{t.labelTimezone}:</div>

                  <select 
                    className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-sm text-slate-200"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  >
                    <option value="UTC">UTC</option>
                    <option value="Asia/Tokyo">Tokyo (JST)</option>
                    <option value="America/New_York">New York (EST/EDT)</option>
                    <option value="Europe/London">London (GMT/BST)</option>
                    <option value={Intl.DateTimeFormat().resolvedOptions().timeZone}>Local ({Intl.DateTimeFormat().resolvedOptions().timeZone})</option>
                  </select>
                </div>
                
                {selectionRange && (
                  <div className="flex gap-2 items-center fade-in">
                    <span className="text-xs text-slate-400">
                      {t.msgSelected}: Index {selectionRange[0]}{selectionRange[0] !== selectionRange[1] ? ` - ${selectionRange[1]}` : ''}
                    </span>
                    <button 
                      className="btn btn-primary text-xs py-1 px-3 flex items-center gap-1"
                      onClick={runCounterfactual}
                      disabled={isCounterfactualLoading}
                    >
                      <Sparkles className="w-3 h-3" /> {t.btnEstimateEffect}
                      <HelpTooltip text={t.helpCounterfactual} />


                    </button>
                    <button 
                      className="btn text-xs py-1 px-3 bg-slate-700 hover:bg-slate-600 flex items-center justify-center"
                      onClick={() => setSelectionRange(null)}
                      title="Clear Selection"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>

              <div 
                className="w-full flex-1" 
                style={{ minHeight: 0 }}
                onWheel={handleWheel}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={processedChartData}
                    margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
                    onMouseDown={handleChartMouseDown}
                    onMouseMove={handleChartMouseMove}
                    onMouseUp={handleChartMouseUp}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis 
                    dataKey="index" 
                    stroke="#94a3b8" 
                    tickFormatter={formatTime}
                    minTickGap={30}
                  />
                  <YAxis stroke="#94a3b8" />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                    itemStyle={{ color: '#f8fafc' }}
                    labelFormatter={formatTime}
                  />
                  
                  {/* Selection Highlight */}
                  {(refAreaLeft !== null && refAreaRight !== null) && (
                    <ReferenceArea
                      x1={data[Number(refAreaLeft)]?.index}
                      x2={data[Number(refAreaRight)]?.index}
                      strokeOpacity={0.3}
                      fill="rgba(59, 130, 246, 0.2)"
                    />
                  )}
                  
                  {selectionRange && (
                    <ReferenceArea
                      x1={data[selectionRange[0]]?.index}
                      x2={data[selectionRange[1]]?.index}
                      strokeOpacity={0.3}
                      fill="rgba(139, 92, 246, 0.15)"
                      stroke="#8b5cf6"
                      strokeDasharray="3 3"
                    />
                  )}
                  
                  <Line 
                    type="monotone" 
                    dataKey="actual_value" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    dot={false}
                    name={t.legendActual}
                    connectNulls
                    isAnimationActive={false}
                  />
                  
                  <Line 
                    type="monotone" 
                    dataKey="predicted_value" 
                    stroke="#8b5cf6" 
                    strokeWidth={2} 
                    strokeDasharray="5 5"
                    dot={false}
                    name={t.legendForecast}

                    connectNulls
                    isAnimationActive={false}
                  />
                  
                  <Scatter 
                    dataKey="anomaly_value" 
                    fill="#ef4444" 
                    name={t.legendAnomaly}
                    isAnimationActive={false}
                  />

                  <Line 
                    type="monotone" 
                    dataKey="counterfactual" 
                    stroke="#10b981" 
                    strokeWidth={2} 
                    strokeDasharray="3 3"
                    dot={false}
                    name={t.legendCounterfactual}

                    connectNulls
                    isAnimationActive={false}
                  />

                  <Area
                    type="monotone"
                    dataKey="pred_interval"
                    stroke="none"
                    fill="#8b5cf6"
                    fillOpacity={0.15}
                    name={t.legendInterval}
                    connectNulls
                    isAnimationActive={false}
                  />
                  
                  {eventAreas.map((ea, i) => {
                    if (ea.start === ea.end) {
                      return (
                        <ReferenceLine 
                          key={`ea-${i}`} 
                          x={ea.start} 
                          stroke="#f59e0b"
                          strokeDasharray="3 3" 
                          label={{ value: ea.name, position: 'insideTopLeft', fill: '#f59e0b', fontSize: 12 }} 
                        />
                      );
                    } else {
                      return (
                        <ReferenceArea 
                          key={`ea-${i}`}
                          x1={ea.start}
                          x2={ea.end}
                          fill="#f59e0b"
                          fillOpacity={0.1}
                          stroke="#f59e0b"
                          strokeOpacity={0.3}
                          label={{ value: ea.name, position: 'insideTopLeft', fill: '#f59e0b', fontSize: 12 }} 
                        />
                      );    
                    }
                  })}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
              <div className="flex gap-4 mt-4 text-sm justify-center flex-wrap shrink-0">
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-blue-500"></div> {t.legendActual}</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-violet-500 border border-violet-500" style={{ borderStyle: 'dotted' }}></div> {t.legendForecast}</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-violet-500/30"></div> {t.legendInterval}</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-500"></div> {t.legendAnomaly}</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-dashed border-emerald-500 bg-transparent"></div> {t.legendCounterfactual}</div>
                <div className="flex items-center gap-2"><div className="w-0.5 h-3 bg-amber-500 border-amber-500" style={{ borderStyle: 'dashed' }}></div> {t.legendEventMarker}</div>
              </div>

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[#94a3b8]">
              <BarChart2 className="w-16 h-16 opacity-20 mb-4" />
              <p>{t.msgNoData}</p>

            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
