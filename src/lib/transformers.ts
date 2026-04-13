export async function analyzeTimeSeries(data: number[], forecastLength: number = 20): Promise<{forecast: number[], anomalies: number[]}> {
  console.log("Requesting TimesFM analysis from Python Backend...");
  
  try {
    const response = await fetch('http://127.0.0.1:8000/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data,
        forecast_length: forecastLength
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`API Error: ${errorData.detail || response.statusText}`);
    }
    
    const result = await response.json();
    return { forecast: result.forecast, anomalies: result.anomalies };
  } catch (err) {
    console.error("Failed to connect to Python backend:", err);
    throw new Error("Cannot connect to TimesFM background service. Ensure the python server is running.");
  }
}
