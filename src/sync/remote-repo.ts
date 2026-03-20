import type { Store, Hash } from '../store/types.js';
import type { RefStore } from '../commit/index.js';
import { Repository } from '../repo/index.js';
import { RemoteSyncClient } from './protocol.js';
import { WebSocketClientTransport } from './ws-client.js';

/**
 * High-level API for syncing a local repository with a remote WebSocket server.
 * Combines WebSocketClientTransport + RemoteSyncClient + local Repository.
 */
export class RemoteRepository {
  private _repo: Repository;
  private _transport: WebSocketClientTransport;
  private _client: RemoteSyncClient;

  private constructor(
    repo: Repository,
    transport: WebSocketClientTransport,
    client: RemoteSyncClient,
  ) {
    this._repo = repo;
    this._transport = transport;
    this._client = client;
  }

  /** Clone from a remote server into local stores. */
  static async clone(
    serverUrl: string,
    localStore: Store,
    localRefs: RefStore,
  ): Promise<RemoteRepository> {
    const transport = new WebSocketClientTransport(serverUrl);
    await transport.connect();

    // Create initial repo for the clone protocol to write blocks/refs into
    const tempRepo = await Repository.init(localStore, localRefs);
    const client = new RemoteSyncClient(tempRepo, transport);
    await client.clone();

    // Re-init to pick up the cloned refs and working tree
    const repo = await Repository.init(localStore, localRefs);
    // Create a new client bound to the re-initialized repo
    const finalClient = new RemoteSyncClient(repo, transport);
    return new RemoteRepository(repo, transport, finalClient);
  }

  /** Connect to a remote server for an existing local repository. */
  static async connect(
    serverUrl: string,
    repo: Repository,
  ): Promise<RemoteRepository> {
    const transport = new WebSocketClientTransport(serverUrl);
    await transport.connect();

    const client = new RemoteSyncClient(repo, transport);
    return new RemoteRepository(repo, transport, client);
  }

  get repo(): Repository {
    return this._repo;
  }

  async push(branch?: string): Promise<{ accepted: boolean; reason?: string }> {
    return this._client.push(branch);
  }

  async pull(branch?: string): Promise<{ status: string }> {
    return this._client.pull(branch);
  }

  onBranchUpdated(handler: (branch: string, commitHash: Hash) => void): void {
    this._client.onBranchUpdated(handler);
  }

  close(): void {
    this._transport.close();
  }
}
