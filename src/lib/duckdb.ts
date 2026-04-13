import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
    mvp: {
        mainModule: duckdb_wasm,
        mainWorker: mvp_worker,
    },
    eh: {
        mainModule: duckdb_wasm_eh,
        mainWorker: eh_worker,
    },
};

let db: duckdb.AsyncDuckDB | null = null;
let connection: duckdb.AsyncDuckDBConnection | null = null;

export async function initDuckDb(): Promise<duckdb.AsyncDuckDBConnection> {
  if (connection) return connection;

  const build = await duckdb.selectBundle(MANUAL_BUNDLES);
  
  const worker = new Worker(build.mainWorker!, { type: 'module' });
  const logger = new duckdb.ConsoleLogger();
  
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(build.mainModule, build.pthreadWorker);
  
  connection = await db.connect();
  return connection;
}

export async function processCSV(filename: string, content: string): Promise<any[]> {
  const conn = await initDuckDb();
  
  // Register file
  await db?.registerFileText(filename, content);
  
  // Create table from CSV
  await conn.query(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv_auto('${filename}');`);
  
  // Get all data
  const result = await conn.query('SELECT * FROM data');
  return result.toArray().map(row => row.toJSON());
}

export async function detectAnomaliesQuery(tableName: string = 'data', timeCol: string, valCol: string): Promise<any[]> {
  const conn = await initDuckDb();
  
  // Simple anomaly detection using Z-score using moving average over 5 periods
  const query = `
    WITH stats AS (
      SELECT 
        ${timeCol}, 
        ${valCol},
        AVG(${valCol}) OVER (ORDER BY ${timeCol} ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as mv_avg,
        STDDEV(${valCol}) OVER (ORDER BY ${timeCol} ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) as mv_std
      FROM ${tableName}
    )
    SELECT
      ${timeCol},
      ${valCol},
      CASE WHEN ABS(${valCol} - mv_avg) > 2 * mv_std THEN true ELSE false END as is_anomaly
    FROM stats
  `;
  
  const result = await conn.query(query);
  return result.toArray().map(row => row.toJSON());
}
