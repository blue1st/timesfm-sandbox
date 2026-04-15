const getBackendUrl = async () => {
  // @ts-ignore
  if (window.require) {
    // @ts-ignore
    const { ipcRenderer } = window.require('electron');
    const port = await ipcRenderer.invoke('get-port');
    return `http://127.0.0.1:${port}`;
  }
  return 'http://127.0.0.1:8000'; // Fallback
};

export async function analyzeTimeSeries(
  data: number[], 
  forecastLength: number = 20, 
  excludeRange?: [number, number],
  sensitivity: number = 2.5
): Promise<{forecast: number[], anomalies: number[], low?: number[], high?: number[], counterfactual?: number[]}> {
  console.log("Requesting TimesFM analysis from Python Backend...");
  
  const baseUrl = await getBackendUrl();
  let response;
  try {
    response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data,
        forecast_length: forecastLength,
        exclude_range: excludeRange,
        anomaly_threshold: sensitivity
      }),
    });
  } catch (err) {
    console.error("Failed to connect to Python backend:", err);
    throw new Error("バックエンドサーバーに接続できません。起動状態を確認してください。");
  }

  if (!response.ok) {
    let errorDetail = response.statusText;
    try {
      const errorData = await response.json();
      if (errorData.detail) errorDetail = typeof errorData.detail === 'string' ? errorData.detail : JSON.stringify(errorData.detail);
    } catch (e) {}
    throw new Error(errorDetail);
  }
  
  const result = await response.json();
  return { 
    forecast: result.forecast, 
    anomalies: result.anomalies,
    low: result.low,
    high: result.high,
    counterfactual: result.counterfactual 
  };
}
