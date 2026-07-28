import fs from "node:fs";
import { promisify } from "node:util";
import { basename } from "node:path";
import { UnsupportedPlatformError } from "./UnsupportedPlatformError";
import https from "node:https";
import os from "node:os";
import { Agent, ProxyAgent } from "undici";
import type { ProxyConfig } from "../http/HttpClientInterface";
import type FormData from "form-data";
import packageJson from "../../package.json";

const readFile = promisify(fs.readFile);

type ClientCertAuth =
  | {
      pfx: Buffer;
      password: string;
    }
  | {
      pfxFilePath: string;
      password: string;
    };

export const readFileFromPath = async (filePath: string) => {
  const data = await readFile(filePath);
  const name = basename(filePath);
  return { data, name };
};

export const getRequestToken = () => {
  throw new UnsupportedPlatformError("Node.js");
};

export const getDefaultAuth = () => {
  throw new UnsupportedPlatformError("Node.js");
};

export const buildPlatformDependentConfig = ({
  httpsAgent,
  clientCertAuth,
  socketTimeout,
}: {
  httpsAgent?: https.Agent;
  clientCertAuth?: ClientCertAuth;
  socketTimeout?: number;
}) => {
  return {
    ...buildHttpsAgentConfig({ httpsAgent, clientCertAuth }),
    ...buildTimeoutConfig({ socketTimeout }),
  };
};

const buildHttpsAgentConfig = ({
  httpsAgent,
  clientCertAuth,
}: {
  httpsAgent?: https.Agent;
  clientCertAuth?: ClientCertAuth;
}) => {
  if (httpsAgent !== undefined) {
    return { httpsAgent };
  }

  // use default HTTPS agent
  if (clientCertAuth !== undefined) {
    const pfx =
      "pfx" in clientCertAuth
        ? clientCertAuth.pfx
        : fs.readFileSync(clientCertAuth.pfxFilePath);
    const defaultHttpsAgent = new https.Agent({
      pfx,
      passphrase: clientCertAuth.password,
    });
    return { httpsAgent: defaultHttpsAgent };
  }
  return {};
};

const buildTimeoutConfig = (params: { socketTimeout?: number }) => {
  if (params.socketTimeout) {
    return { timeout: params.socketTimeout };
  }

  return {};
};

export const buildHeaders = (params: { userAgent?: string }) => {
  const { userAgent } = params;
  return {
    "User-Agent": `Node.js/${process.version}(${os.type()}) ${
      packageJson.name
    }@${packageJson.version}${userAgent ? ` ${userAgent}` : ""}`,
  };
};

export const buildFormDataValue = (data: unknown) => {
  return data;
};

export const buildBaseUrl = (baseUrl: string | undefined) => {
  if (typeof baseUrl === "undefined") {
    throw new Error("in Node.js environment, baseUrl is required");
  }
  return baseUrl;
};

export const getVersion = () => {
  return packageJson.version;
};

export const buildFetchFormData = (
  data: unknown,
): { body: unknown; contentType?: string; duplex?: "half" } | null => {
  if (
    !data ||
    typeof data !== "object" ||
    !("getBuffer" in data && typeof (data as any).getBuffer === "function") ||
    !("getBoundary" in data && typeof (data as any).getBoundary === "function")
  ) {
    return null;
  }
  const fd = data as FormData;
  return {
    // `fd.getBuffer()` throws if any appended field is a Stream (e.g. a
    // `fs.createReadStream()` passed as `file.data`, which docs/file.md
    // documents as supported), so bridge the FormData's own "data"/"end"
    // events into a ReadableStream instead of buffering it eagerly.
    body: buildReadableStreamFromFormData(fd),
    contentType: `multipart/form-data; boundary=${fd.getBoundary()}`,
    // Required by the Fetch spec whenever the body is a ReadableStream.
    duplex: "half",
  };
};

/* eslint-disable n/no-unsupported-features/node-builtins --
   ReadableStream has been available in Node.js since well before this
   package's minimum supported version; it's only listed as "experimental"
   until 22.15/23.11 in terms of API stability commitment, not availability -
   fetch() (used unconditionally elsewhere in this codebase) already depends
   on it being present. */
const buildReadableStreamFromFormData = (
  formData: FormData,
): ReadableStream<Uint8Array> => {
  return new ReadableStream({
    start(controller) {
      formData.on("data", (chunk: Buffer | string) => {
        // Text fields can come through as plain strings rather than
        // Buffers; fetch's body reader requires Uint8Array chunks.
        controller.enqueue(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        );
      });
      formData.on("end", () => controller.close());
      formData.on("error", (error: Error) => controller.error(error));
      // `form-data` (built on `combined-stream`) only starts flowing once
      // explicitly resumed - unlike modern Readable streams, attaching a
      // "data" listener alone does not start the flow.
      formData.resume();
    },
  });
};
/* eslint-enable n/no-unsupported-features/node-builtins */

export const buildFetchDispatcher = ({
  httpsAgent,
  clientCertAuth,
  proxy,
  socketTimeout,
}: {
  httpsAgent?: unknown;
  clientCertAuth?: unknown;
  proxy?: ProxyConfig;
  socketTimeout?: number;
}): unknown => {
  const tlsOptions = buildTlsOptions({
    httpsAgent: httpsAgent as https.Agent | undefined,
    clientCertAuth: clientCertAuth as ClientCertAuth | undefined,
  });

  // Proxy configuration (proxy can be false to explicitly disable)
  if (proxy && typeof proxy === "object") {
    return buildProxyDispatcher(proxy, tlsOptions, socketTimeout);
  }

  // TLS or timeout configuration
  if (tlsOptions || socketTimeout) {
    return new Agent({
      connect: tlsOptions || {},
      connectTimeout: socketTimeout,
    });
  }

  return undefined;
};

const buildProxyDispatcher = (
  proxy: Exclude<ProxyConfig, false | undefined>,
  tlsOptions: Record<string, unknown> | undefined,
  socketTimeout?: number,
): ProxyAgent => {
  const proxyUrl = buildProxyUrl(proxy);

  return new ProxyAgent({
    uri: proxyUrl,
    requestTls: tlsOptions,
    connectTimeout: socketTimeout,
  });
};

const buildProxyUrl = (
  proxy: Exclude<ProxyConfig, false | undefined>,
): string => {
  const protocol = proxy.protocol ?? "http";
  const auth = proxy.auth
    ? `${encodeURIComponent(proxy.auth.username)}:${encodeURIComponent(proxy.auth.password)}@`
    : "";
  return `${protocol}://${auth}${proxy.host}:${proxy.port}`;
};

const buildTlsOptions = ({
  httpsAgent,
  clientCertAuth,
}: {
  httpsAgent?: https.Agent;
  clientCertAuth?: ClientCertAuth;
}): Record<string, unknown> | undefined => {
  // Extract TLS options from existing httpsAgent for compatibility
  if (httpsAgent) {
    const options = httpsAgent.options || {};
    const tlsOptions: Record<string, unknown> = {};

    if (options.pfx) {
      tlsOptions.pfx = options.pfx;
    }
    if (options.passphrase) {
      tlsOptions.passphrase = options.passphrase;
    }
    if (options.cert) {
      tlsOptions.cert = options.cert;
    }
    if (options.key) {
      tlsOptions.key = options.key;
    }
    if (options.ca) {
      tlsOptions.ca = options.ca;
    }
    if (options.rejectUnauthorized !== undefined) {
      tlsOptions.rejectUnauthorized = options.rejectUnauthorized;
    }

    return Object.keys(tlsOptions).length > 0 ? tlsOptions : undefined;
  }

  // Build TLS options from clientCertAuth
  if (clientCertAuth) {
    const pfx =
      "pfx" in clientCertAuth
        ? clientCertAuth.pfx
        : fs.readFileSync(clientCertAuth.pfxFilePath);

    return {
      pfx,
      passphrase: clientCertAuth.password,
    };
  }

  return undefined;
};
