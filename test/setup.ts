import { env } from 'cloudflare:test';

// マイグレーション SQL を実行
await env.DB.prepare('CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, cron TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)').run();
await env.DB.prepare('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, trigger_type TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error_summary TEXT)').run();
await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_runs_workflow_started ON runs (workflow_id, started_at DESC)').run();
await env.DB.prepare('CREATE TABLE IF NOT EXISTS run_steps (run_id TEXT NOT NULL, node_id TEXT NOT NULL, node_name TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, output_preview TEXT, output_r2_key TEXT, error TEXT, PRIMARY KEY (run_id, node_id))').run();
