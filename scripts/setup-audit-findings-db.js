#!/usr/bin/env node
/**
 * setup-audit-findings-db.js — one-shot script to create the Padeli Audit Findings
 * Notion database. Saves the resulting database_id to ./data/audit-findings-db.json.
 *
 * Usage: NOTION_API_KEY=... node scripts/setup-audit-findings-db.js
 *
 * Idempotent: if data/audit-findings-db.json already exists, exits without action.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const NOTION_KEY = process.env.NOTION_API_KEY;
if (!NOTION_KEY) {
  console.error('Missing NOTION_API_KEY env var');
  process.exit(1);
}

const PADELI_HQ_PAGE_ID = '356d1b51-fb30-8116-98f9-c3dcaa93d85b';
const CLUB_TRACKER_DB_ID = '35bd1b51-fb30-8106-a719-ec603a1a3616';
const BLOG_TRACKER_DB_ID = '35bd1b51-fb30-813b-996f-e67ac30f6418';

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'audit-findings-db.json');

if (fs.existsSync(CONFIG_FILE)) {
  const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  console.log('Audit Findings DB already exists:');
  console.log('  ID:  ' + existing.database_id);
  console.log('  URL: ' + existing.database_url);
  console.log('Delete data/audit-findings-db.json if you want to recreate.');
  process.exit(0);
}

function notionApi(endpoint, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.notion.com',
      path: '/v1' + endpoint,
      method,
      headers: {
        'Authorization': 'Bearer ' + NOTION_KEY,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(chunks);
          if (res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode + ': ' + (parsed.message || chunks)));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Parse error: ' + chunks));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const dbSchema = {
  parent: { type: 'page_id', page_id: PADELI_HQ_PAGE_ID },
  is_inline: true,
  icon: { type: 'emoji', emoji: '🔎' },
  title: [{ type: 'text', text: { content: 'Padeli Audit Findings' } }],
  description: [{ type: 'text', text: { content: 'Per-finding audit log. One row per issue surfaced by /padeli:audit-content. Status flow: Open → Fixed / Won\'t Fix / Manual Review.' } }],
  properties: {
    'Name': { title: {} },
    'Listing': { relation: { database_id: CLUB_TRACKER_DB_ID, single_property: {} } },
    'Post': { relation: { database_id: BLOG_TRACKER_DB_ID, single_property: {} } },
    'Check ID': { rich_text: {} },
    'Severity': {
      select: {
        options: [
          { name: 'Error', color: 'red' },
          { name: 'Warning', color: 'yellow' },
          { name: 'Info', color: 'blue' },
        ],
      },
    },
    'Domain': {
      select: {
        options: [
          { name: 'QC', color: 'default' },
          { name: 'Yoast SEO', color: 'purple' },
          { name: 'Expert SEO', color: 'orange' },
          { name: 'Live Page', color: 'green' },
          { name: 'Link Validation', color: 'pink' },
          { name: 'GSC Performance', color: 'blue' },
          { name: 'GA Engagement', color: 'brown' },
        ],
      },
    },
    'Message': { rich_text: {} },
    'Status': {
      select: {
        options: [
          { name: 'Open', color: 'red' },
          { name: 'Fixed', color: 'green' },
          { name: "Won't Fix", color: 'gray' },
          { name: 'Manual Review', color: 'yellow' },
        ],
      },
    },
    'Type': {
      select: {
        options: [
          { name: 'Listing', color: 'blue' },
          { name: 'Post', color: 'purple' },
        ],
      },
    },
    'WP ID': { number: { format: 'number' } },
    'Found': { date: {} },
    'Resolved': { date: {} },
  },
};

(async () => {
  try {
    console.log('Creating Padeli Audit Findings database under Padeli HQ...');
    const result = await notionApi('/databases', 'POST', dbSchema);
    console.log('✓ Created:');
    console.log('  Database ID: ' + result.id);
    console.log('  URL: ' + result.url);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      database_id: result.id,
      database_url: result.url,
      created_at: new Date().toISOString(),
      note: 'Padeli Audit Findings — per-finding audit log',
    }, null, 2));
    console.log('  Saved config to: ' + CONFIG_FILE);
    console.log('\nNext: run `node content-auditor.js listing <id>` and findings will appear here.');
  } catch (err) {
    console.error('Failed to create database:', err.message);
    process.exit(1);
  }
})();
