import { mock } from 'bun:test';
import { env } from './cloudflare-workers';

mock.module('cloudflare:workers', () => ({ env }));
