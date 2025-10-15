import express from 'express';

const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

const shardId = process.env.SHARD_ID || process.env.pm_id || '0'; // pm2互換対策も兼ねる
const isMaster = shardId === '0';
