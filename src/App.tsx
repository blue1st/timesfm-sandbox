import React, { useState, useEffect } from 'react';
import packageJson from '../package.json';
import { UploadCloud, Play, Activity, Sparkles, FileText, BarChart2, Download, Cloud, Database, Key, X, Trash2 } from 'lucide-react';
import { 
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Scatter, ReferenceArea, Area, ReferenceLine
} from 'recharts';

import { processCSV } from './lib/duckdb';
import { analyzeTimeSeries } from './lib/transformers';
import { getBackendUrl } from './lib/backend';
import './index.css';

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
  const [status, setStatus] = useState('Idle');
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
  
  const [backendStatus, setBackendStatus] = useState<{status: string, message: string, model_id?: string}>({status: 'idle', message: 'Checking backend...'});

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
        setBackendStatus({status: 'error', message: 'Backend unreachable'});
      }
    };
    
    checkStatus();
    const timer = setInterval(checkStatus, 2000);
    return () => clearInterval(timer);
  }, []);

  // Auto-run analysis when backend becomes ready
  useEffect(() => {
    if (backendStatus.status === 'ready' && rawRows.length > 0 && selectedValueCol) {
      runAnalysis(rawRows, selectedTimeCol, selectedValueCol, selectedEventCol);
    }
  }, [backendStatus.status]);
  
  const runAnalysis = async (rows: any[], timeCol: string, valCol: string, eventCol: string = '', currentSensitivity: number = sensitivity) => {
    try {
      if (!valCol || !rows || rows.length === 0) return;
      
      setIsProcessing(true);
      setStatus('Detecting anomalies...');
      
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
      
      setData(chartData);
      
      const valuesArray = chartData.map(d => d.value).filter(v => !isNaN(v));
      
      const { forecast, anomalies, low, high } = await analyzeTimeSeries(valuesArray, 20, undefined, currentSensitivity);
      
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
      setStatus('Complete');
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
    setStatus('Idle');
    setPastedText('');
    setIsProcessing(false);
  };

  const handleDataInput = async (content: string) => {
    try {
      setIsProcessing(true);
      setStatus('Loading DuckDB & parsing data...');
      
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
      
      setStatus('Starting analysis...');
      await runAnalysis(combinedRows, timeColToUse, valColToUse, eventColToUse);
      
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
      setStatus('Running Counterfactual Analysis...');
      
      const observedData = data.filter(d => !d.is_prediction);
      const valuesArray = observedData.map(d => d.value);
      
      const { counterfactual } = await analyzeTimeSeries(
        valuesArray, 
        20, 
        selectionRange
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
        setStatus('Counterfactual Analysis Complete');
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
    setStatus('Counterfactual Analysis Reset');
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
      setStatus('Wait for Google Auth in browser...');
      const baseUrl = await getBackendUrl();
      const response = await fetch(`${baseUrl}/gcp/auth`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Auth failed');
      setIsAuthenticated(true);
      setStatus('Authenticated with Google Cloud');
    } catch (e: any) {
      alert(`Authentication failed: ${e.message}\n(Ensure client_secret.json is in the project root)`);
      setStatus('Auth Failed');
    }
  };

  const fetchGCSData = async () => {
    if (!gsUrl.trim()) return;
    try {
      setIsProcessing(true);
      setStatus('Loading from GCS...');
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
      setStatus('GCS Load Failed');
      setIsProcessing(false);
    }
  };

  const fetchBQData = async () => {
    if (!bqProject.trim() || !bqQuery.trim()) return;
    try {
      setIsProcessing(true);
      setStatus('Executing BigQuery...');
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
      setStatus('BigQuery Failed');
      setIsProcessing(false);
    }
  };

  const handleChartMouseDown = (e: any) => {
    if (e && e.activeTooltipIndex !== undefined) {
      setRefAreaLeft(e.activeTooltipIndex);
    }
  };

  const handleChartMouseMove = (e: any) => {
    if (refAreaLeft !== null && e && e.activeTooltipIndex !== undefined) {
      setRefAreaRight(e.activeTooltipIndex);
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

  return (
    <div className="app-container">
      <header>
        <h1>
          <Activity className="w-8 h-8 text-primary" /> 
          TimesFM Sandbox 
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
            <h2><FileText className="w-5 h-5" /> Data Source</h2>
            
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'paste' ? 'active' : ''}`}
                onClick={() => setActiveTab('paste')}
              >
                Paste
              </button>
              <button 
                className={`tab ${activeTab === 'upload' ? 'active' : ''}`}
                onClick={() => setActiveTab('upload')}
              >
                File
              </button>
              <button 
                className={`tab ${activeTab === 'gcs' ? 'active' : ''}`}
                onClick={() => setActiveTab('gcs')}
              >
                GCS
              </button>
              <button 
                className={`tab ${activeTab === 'bigquery' ? 'active' : ''}`}
                onClick={() => setActiveTab('bigquery')}
              >
                BigQuery
              </button>
            </div>
            
            {!isAuthenticated && (activeTab === 'gcs' || activeTab === 'bigquery') && (
              <div className="p-4 mb-4 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm">
                <p className="mb-3 text-[#cbd5e1]">Requires Google Cloud authentication using a local OAuth flow.</p>
                <button className="btn w-full bg-blue-600 hover:bg-blue-500 flex justify-center items-center gap-2" onClick={handleGCPAuth}>
                  <Key className="w-4 h-4" /> Authenticate with Google
                </button>
              </div>
            )}

            {activeTab === 'paste' ? (
              <>
                <textarea 
                  placeholder="Paste CSV/TSV here...&#10;Date,Value&#10;2024-01-01,120&#10;2024-01-02,125"
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                />
                <button 
                  className="btn btn-primary" 
                  onClick={processPastedData}
                  disabled={isProcessing || !pastedText.trim()}
                >
                  <Play className="w-4 h-4" /> Analyze Data
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
                  placeholder="gs://your-bucket-name/data.csv"
                  value={gsUrl}
                  onChange={(e) => setGsUrl(e.target.value)}
                  disabled={!isAuthenticated}
                />
                <button 
                  className="btn btn-primary mt-2" 
                  onClick={fetchGCSData}
                  disabled={isProcessing || !gsUrl.trim() || !isAuthenticated}
                >
                  <Play className="w-4 h-4" /> Load & Analyze
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
                  placeholder="GCP Project ID (e.g. my-project-123)"
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
                  <Play className="w-4 h-4" /> Run Query & Analyze
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
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Database className="w-4 h-4 text-accent" /> Column Mapping</h3>
                
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Time Axis (X)</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200"
                      value={selectedTimeCol}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedTimeCol(val);
                        runAnalysis(rawRows, val, selectedValueCol, selectedEventCol);
                      }}
                      disabled={isProcessing}
                    >
                      <option value="">(Auto Index)</option>
                      {availableColumns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Value (Y)</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200"
                      value={selectedValueCol}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedValueCol(val);
                        runAnalysis(rawRows, selectedTimeCol, val, selectedEventCol);
                      }}
                      disabled={isProcessing}
                    >
                      {availableColumns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Event Marker Column (Optional)</label>
                    <select 
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200"
                      value={selectedEventCol}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedEventCol(val);
                        runAnalysis(rawRows, selectedTimeCol, selectedValueCol, val);
                      }}
                      disabled={isProcessing}
                    >
                      <option value="">(None)</option>
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
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Sparkles className="w-4 h-4 text-amber-500" /> Manual Event Labeling</h3>
                <div className="flex flex-col gap-2 p-3 bg-slate-900 rounded border border-slate-700">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Start Time</label>
                      <select 
                        className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500"
                        value={eventStartInput}
                        onChange={(e) => setEventStartInput(e.target.value)}
                      >
                        <option value="">-- Select Start --</option>
                        {data.map((d, i) => (
                           <option key={`start-${i}`} value={String(d.index)}>{formatTime(d.index)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">End Time (Optional)</label>
                      <select 
                        className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500"
                        value={eventEndInput}
                        onChange={(e) => setEventEndInput(e.target.value)}
                      >
                        <option value="">-- Same as Start --</option>
                        {data.map((d, i) => (
                           <option key={`end-${i}`} value={String(d.index)}>{formatTime(d.index)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Event Name</label>
                    <input 
                      type="text" 
                      className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500"
                      placeholder="Name of the event"
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
                      Set Event
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
                      Clear Target Event
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
                <Trash2 className="w-4 h-4" /> Reset All Data
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
                    setBackendStatus(prev => ({ ...prev, status: 'loading', message: `Switching to ${modelId}...` }));
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
                  <p className="font-semibold flex items-center gap-1"><Sparkles className="w-3 h-3 text-amber-500" /> Anomaly Sensitivity</p>
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
                  onMouseUp={() => {
                    if (rawRows.length > 0) {
                      runAnalysis(rawRows, selectedTimeCol, selectedValueCol, selectedEventCol, sensitivity);
                    }
                  }}
                />
                <div className="flex justify-between mt-1 text-[8px] text-slate-500 font-mono">
                  <span>SENSITIVE</span>
                  <span>NORMAL(2.5)</span>
                  <span>STRICT</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
        
        <main className="glass-card chart-container fade-in" style={{ animationDelay: '0.1s' }}>
          <div className="chart-header">
            <h2 className="chart-title flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-accent" />
              Analysis Results
            </h2>
            <div className="flex gap-2">
              {data.some(d => d.counterfactual !== undefined) && (
                <button 
                  className="btn text-sm px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 flex items-center gap-2" 
                  onClick={clearCounterfactual}
                >
                  <X className="w-4 h-4" /> Clear Effect
                </button>
              )}
              {data.length > 0 && (
                <button className="btn text-sm px-3 py-1.5 bg-[rgba(255,255,255,0.1)] hover:bg-[rgba(255,255,255,0.2)] border border-[#334155] flex items-center gap-2" onClick={exportToCSV}>
                  <Download className="w-4 h-4" /> Export CSV
                </button>
              )}
            </div>
          </div>
          
          {data.length > 0 ? (
            <div className="w-full flex flex-col flex-1" style={{ minHeight: 0 }}>
              <div className="flex justify-between items-center mb-4 shrink-0">
                <div className="flex gap-4 items-center">
                  <div className="text-sm font-medium text-slate-400">Timezone:</div>
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
                      Selected: Index {selectionRange[0]}{selectionRange[0] !== selectionRange[1] ? ` - ${selectionRange[1]}` : ''}
                    </span>
                    <button 
                      className="btn btn-primary text-xs py-1 px-3 flex items-center gap-1"
                      onClick={runCounterfactual}
                      disabled={isCounterfactualLoading}
                    >
                      <Sparkles className="w-3 h-3" /> Estimate Effect
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

              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={data.map((d, i) => {
                    const isLastObserved = !d.is_prediction && data[i + 1]?.is_prediction;
                    return {
                      ...d,
                      actual_value: !d.is_prediction ? d.value : null,
                      predicted_value: d.is_prediction ? d.value : (isLastObserved ? d.value : null),
                      anomaly_value: d.is_anomaly ? d.value : null,
                      pred_interval: d.is_prediction && d.low !== undefined && d.high !== undefined 
                        ? [d.low, d.high] 
                        : (isLastObserved ? [d.value, d.value] : null)
                    };
                  })}
                  margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
                  onMouseDown={handleChartMouseDown}
                  onMouseMove={handleChartMouseMove}
                  onMouseUp={handleChartMouseUp}
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
                    name="Actual"
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
                    name="TimesFM Forecast"
                    connectNulls
                    isAnimationActive={false}
                  />
                  
                  <Scatter 
                    dataKey="anomaly_value" 
                    fill="#ef4444" 
                    name="Anomaly"
                    isAnimationActive={false}
                  />

                  <Line 
                    type="monotone" 
                    dataKey="counterfactual" 
                    stroke="#10b981" 
                    strokeWidth={2} 
                    strokeDasharray="3 3"
                    dot={false}
                    name="No-Event Counterfactual"
                    connectNulls
                    isAnimationActive={false}
                  />

                  <Area
                    type="monotone"
                    dataKey="pred_interval"
                    stroke="none"
                    fill="#8b5cf6"
                    fillOpacity={0.15}
                    name="Prediction Interval (80%)"
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
              <div className="flex gap-4 mt-4 text-sm justify-center flex-wrap shrink-0">
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-blue-500"></div> Actual</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-violet-500 border border-violet-500" style={{ borderStyle: 'dotted' }}></div> Forecast</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-violet-500/30"></div> Interval (80%)</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-500"></div> Anomaly</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-dashed border-emerald-500 bg-transparent"></div> Counterfactual</div>
                <div className="flex items-center gap-2"><div className="w-0.5 h-3 bg-amber-500 border-amber-500" style={{ borderStyle: 'dashed' }}></div> Event Marker</div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[#94a3b8]">
              <BarChart2 className="w-16 h-16 opacity-20 mb-4" />
              <p>Upload or paste data to view analysis</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
