import {env} from 'cloudflare:workers';
import {handleRequest} from '../../../lib/handler.js';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleRequest(request, env);
export const POST = (request: Request) => handleRequest(request, env);
