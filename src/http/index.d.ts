import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { MyMusic5Client } from "../index.js";

export interface ServerOptions {
    client?: MyMusic5Client;
}

export function createApiHandler(options?: ServerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function createApiServer(options?: ServerOptions): Server;
