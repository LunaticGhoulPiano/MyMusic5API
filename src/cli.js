#!/usr/bin/env node
import { createApiServer } from "./http/index.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error("PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
}
else {
    const server = createApiServer();
    server.on("error", (error) => {
        console.error(`Unable to start MyMusic5 API: ${error.code ?? "SERVER_ERROR"}`);
        process.exitCode = 1;
    });
    server.listen(port, host, () => {
        console.log(`MyMusic5 API listening at http://${host.includes(":") ? `[${host}]` : host}:${port}`);
    });
    const stop = () => {
        server.close();
        const timer = setTimeout(() => server.closeAllConnections(), 5_000);
        timer.unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}
