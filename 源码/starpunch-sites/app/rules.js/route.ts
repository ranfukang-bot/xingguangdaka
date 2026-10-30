import source from '../../domain/rules.cjs?raw';
export function GET() { return new Response(source, {headers:{'Content-Type':'text/javascript; charset=utf-8'}}); }
