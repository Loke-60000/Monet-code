import type { AccountRecord, ProviderId } from "./types.js";

export interface BridgeWorkerStartMessage {
  type: "start";
  providerId: ProviderId;
  account: AccountRecord;
}

export interface BridgeWorkerShutdownMessage {
  type: "shutdown";
}

export type BridgeWorkerRequest =
  | BridgeWorkerStartMessage
  | BridgeWorkerShutdownMessage;

export interface BridgeWorkerReadyMessage {
  type: "ready";
  url: string;
}

export interface BridgeWorkerErrorMessage {
  type: "error";
  message: string;
}

export type BridgeWorkerResponse =
  | BridgeWorkerReadyMessage
  | BridgeWorkerErrorMessage;
