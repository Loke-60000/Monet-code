import type { AccountRecord, RoutedModelOption } from "./types.js";

export interface BridgeWorkerStartMessage {
  type: "start";
  activeAccountId: string;
  accounts: AccountRecord[];
  routedModels: RoutedModelOption[];
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
