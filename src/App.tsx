import React, { useState } from 'react';
import { UploadCloud, Play, Activity, Sparkles, FileText, BarChart2, Download, Cloud, Database, Key } from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Scatter, ReferenceArea
} from 'recharts';

import { processCSV } from './lib/duckdb';
import { analyzeTimeSeries } from './lib/transformers';
import './index.css';

interface DataPoint {
  index: number | string;
  value: number;
  is_anomaly?: boolean;
  is_prediction?: boolean;
  counterfactual?: number;
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
  
  // Selection & Timezone states
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [refAreaLeft, setRefAreaLeft] = useState<number | string | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<number | string | null>(null);
  const [selectionRange, setSelectionRange] = useState<[number, number] | null>(null);
  const [isCounterfactualLoading, setIsCounterfactualLoading] = useState(false);
  
  const handleDataInput = async (content: string) => {
    try {
      setIsProcessing(true);
      setStatus('Loading DuckDB & parsing data...');
      
      // We assume simple CSV/TSV. For robustness we try to guess structure, 
      // but let's just let DuckDB parse it with read_csv_auto.
      const rows = await processCSV('input.csv', content);
      
      if (rows.length === 0) {
        throw new Error("No data found");
      }
      
      const keys = Object.keys(rows[0]);
      // Assuming first column is time/index, second is value, or just 1 column as value
      const valCol = keys.length > 1 ? keys[1] : keys[0];
      const timeCol = keys.length > 1 ? keys[0] : null;
      
      setStatus('Detecting anomalies...');
      
      // DuckDB parsing ONLY now, as Anomaly Detection moves to TimesFM
      const chartData: DataPoint[] = rows.map((row, i) => ({
        index: timeCol ? row[timeCol] : (row._index ?? i),
        value: Number(row[valCol]),
        is_anomaly: false // Will be updated by TimesFM soon
      }));
      
      setData(chartData);
      
      // Format array for TimesFM backend
      const valuesArray = chartData.map(d => d.value).filter(v => !isNaN(v));
      
      setStatus('Running TimesFM Predict & Anomaly Detection...');
      
      const { forecast, anomalies } = await analyzeTimeSeries(valuesArray, 20); // predict 20 steps
      
      // Create a completely new array to avoid mutating frozen state objects
      const chartDataWithAnomalies = chartData.map((item, idx) => ({
        ...item,
        is_anomaly: anomalies.includes(idx)
      }));
      
      // Append predictions to chart data
      const lastIndex = chartDataWithAnomalies.length > 0 ? Number(chartDataWithAnomalies[chartDataWithAnomalies.length - 1].index) : 0;
      
      const predictionData: DataPoint[] = forecast.map((val, i) => ({
        index: isNaN(lastIndex) ? `Pred ${i+1}` : lastIndex + i + 1,
        value: val,
        is_prediction: true,
      }));
      
      setData([...chartDataWithAnomalies, ...predictionData]);
      setStatus('Complete');
      setSelectionRange(null); // Reset selection on new data
      
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${(error as Error).message}`);
    } finally {
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
        // Append counterfactual data to the existing data points
        // starting from selectionRange[0]
        const newData = [...data];
        const startIdx = selectionRange[0];
        
        // Mark counterfactual points
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

  const formatTime = (time: string | number) => {
    if (typeof time === 'number') return time;
    try {
      const date = new Date(time);
      if (isNaN(date.getTime())) return time;
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch {
      return time;
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      handleDataInput(text);
    };
    reader.readAsText(file);
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
    
    // Create CSV Header
    let csvContent = "TimeIndex,Value,IsAnomaly,IsPrediction\n";
    
    // Append rows
    data.forEach((row) => {
      const isAnomaly = row.is_anomaly ? 'TRUE' : 'FALSE';
      const isPrediction = row.is_prediction ? 'TRUE' : 'FALSE';
      csvContent += `${row.index},${row.value},${isAnomaly},${isPrediction}\n`;
    });
    
    // Create blob and trigger download
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
      setStatus('Waiting for Google Auth in browser...');
      const response = await fetch('http://127.0.0.1:8000/gcp/auth');
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
      const response = await fetch('http://127.0.0.1:8000/gcp/gcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gs_url: gsUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail);
      // The backend returns a raw CSV string in `csv` key
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
      const response = await fetch('http://127.0.0.1:8000/gcp/bigquery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: bqProject, query: bqQuery })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail);
      // The backend returns a raw CSV string in `csv` key
      handleDataInput(data.csv);
    } catch (e: any) {
      alert(`BigQuery Error: ${e.message}`);
      setStatus('BigQuery Failed');
      setIsProcessing(false);
    }
  };

  // Extract separate arrays for charting to handle different styles
  // We'll just render it normally with Recharts using conditional properties
  
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
    if (refAreaLeft !== null && refAreaRight !== null) {
      const left = Number(refAreaLeft);
      const right = Number(refAreaRight);
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      
      // Only select if it's within actual data (not prediction)
      const observedCount = data.filter(d => !d.is_prediction).length;
      if (start < observedCount) {
        setSelectionRange([start, Math.min(end, observedCount - 1)]);
      }
    }
    setRefAreaLeft(null);
    setRefAreaRight(null);
  };
  
  return (
    <div className="app-container">
      <header>
        <h1><Activity className="w-8 h-8 text-primary" /> TimesFM Sandbox</h1>
        <div className={`status-badge ${isProcessing ? 'processing' : status === 'Complete' ? 'active' : ''}`}>
          <div className="status-indicator"></div>
          {status}
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
            
            <div className="mt-4 text-xs text-[#94a3b8] p-3 rounded bg-[rgba(0,0,0,0.2)] border border-[#334155]">
              <p className="font-semibold mb-1 flex items-center gap-1"><Sparkles className="w-3 h-3" /> Powered by:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>DuckDB WASM (Anomaly Detection)</li>
                <li>Transformers.js (TimesFM Simulation)</li>
              </ul>
            </div>
          </div>
        </aside>
        
        <main className="glass-card chart-container fade-in" style={{ animationDelay: '0.1s' }}>
          <div className="chart-header">
            <h2 className="chart-title flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-accent" />
              Analysis Results
            </h2>
            {data.length > 0 && (
              <button className="btn text-sm p-3 bg-[rgba(255,255,255,0.1)] hover:bg-[rgba(255,255,255,0.2)] border border-[#334155]" onClick={exportToCSV}>
                <Download className="w-4 h-4" /> Export CSV
              </button>
            )}
          </div>
          
          {data.length > 0 ? (
            <div className="h-full w-full min-h-[400px]" style={{ flex: 1 }}>
              <div className="flex justify-between items-center mb-4">
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
                      Selected: Index {selectionRange[0]} - {selectionRange[1]}
                    </span>
                    <button 
                      className="btn btn-primary text-xs py-1 px-3"
                      onClick={runCounterfactual}
                      disabled={isCounterfactualLoading}
                    >
                      <Sparkles className="w-3 h-3" /> Estimate Effect
                    </button>
                    <button 
                      className="btn text-xs py-1 px-3 bg-slate-700 hover:bg-slate-600"
                      onClick={() => setSelectionRange(null)}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data}
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
                    /* @ts-ignore - Recharts internal components sometimes have tricky types */
                    <ReferenceArea
                      x1={data[Number(refAreaLeft)]?.index}
                      x2={data[Number(refAreaRight)]?.index}
                      strokeOpacity={0.3}
                      fill="rgba(59, 130, 246, 0.2)"
                    />
                  )}
                  
                  {selectionRange && (
                    /* @ts-ignore */
                    <ReferenceArea
                      x1={data[selectionRange[0]]?.index}
                      x2={data[selectionRange[1]]?.index}
                      strokeOpacity={0.3}
                      fill="rgba(139, 92, 246, 0.15)"
                      stroke="#8b5cf6"
                      strokeDasharray="3 3"
                    />
                  )}
                  
                  {/* Actual Data Line */}
                  <Line 
                    type="monotone" 
                    dataKey={(d) => d.is_prediction ? null : d.value} 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    dot={false}
                    name="Actual"
                    connectNulls
                  />
                  
                  {/* Prediction Line */}
                  <Line 
                    type="monotone" 
                    dataKey={(d) => d.is_prediction ? d.value : null} 
                    stroke="#8b5cf6" 
                    strokeWidth={2} 
                    strokeDasharray="5 5"
                    dot={false}
                    name="TimesFM Forecast"
                    connectNulls
                  />
                  
                  {/* Anomalies Scatter */}
                  <Scatter 
                    dataKey={(d) => d.is_anomaly ? d.value : null} 
                    fill="#ef4444" 
                    name="Anomaly"
                  />

                  {/* Counterfactual Line */}
                  <Line 
                    type="monotone" 
                    dataKey="counterfactual" 
                    stroke="#10b981" 
                    strokeWidth={2} 
                    strokeDasharray="3 3"
                    dot={false}
                    name="No-Event Counterfactual"
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
              
              <div className="flex gap-4 mt-4 text-sm justify-center flex-wrap">
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-blue-500"></div> Actual</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-violet-500 border border-violet-500" style={{ borderStyle: 'dotted' }}></div> Forecast</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-red-500"></div> Anomaly</div>
                <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-dashed border-emerald-500 bg-transparent"></div> Counterfactual</div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[#94a3b8]">
              <LineChart className="w-16 h-16 opacity-20 mb-4" />
              <p>Upload or paste data to view analysis</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
