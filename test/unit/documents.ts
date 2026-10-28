// A sample domain service, as an app's domains tier writes one: a stateless object over the Client,
// one endpoint per route, checked against Service with `satisfies`. It is test code, never
// exported by the package: test/unit/api.test.js runs it against a loopback server, and
// type-checks it with tsc. A later slice adds its upload endpoint.

import type { Client, Page } from "@jaimestill/spike-html-apps-sdk/api.js";
import type { Service, ServiceFactory } from "@jaimestill/spike-html-apps-sdk/service.js";

/** A document as the sample server writes it. */
export interface Document {
  id: number;
  title: string;
}

/** The documents service: a document by id, a page of them by number, and a chat about one, its
 * answer streamed as server-sent events. */
export const documents = ((client: Client) =>
  ({
    get: (id: number, signal?: AbortSignal) => client.get<Document>(`documents/${id}`, { signal }),
    list: (page?: number, signal?: AbortSignal) =>
      client.get<Page<Document>>("documents", { query: { page }, signal }),
    chat: (id: number, prompt: string, signal?: AbortSignal) =>
      client.stream(`documents/${id}/chat`, { prompt }, { signal }),
  }) satisfies Service) satisfies ServiceFactory<Service>;
