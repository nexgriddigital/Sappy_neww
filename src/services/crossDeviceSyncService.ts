import { storageService } from './storageService.ts';
import { getSupabase, getSupabaseCredentials, isSupabaseConfigured } from '../lib/supabase.ts';
import { Sale, CreditPayment, Expense } from '../types/pos.ts';
import {
  decodeCustomerFromRemoteRow,
  decodeSaleFromRemoteRow,
  encodeCustomerNotesWithMeta,
  encodeSaleNotesWithReturnMetadata,
} from '../utils/syncMetadataCodec.ts';

export type SyncStatusType = 'synced' | 'syncing' | 'offline' | 'error';
export type SyncModeType = 'server' | 'supabase' | 'local';
export type AutoSyncMode = 'live' | 'manual';

export interface SyncState {
  status: SyncStatusType;
  mode: SyncModeType;
  autoSyncMode: AutoSyncMode;
  lastSyncedAt: string | null;
  message: string;
  serverVersion: number;
}

type SyncListener = (state: SyncState) => void;

export const DEFAULT_CLOUD_BACKEND_URL = '';
const RESET_EPOCH_STORAGE_KEY = 'sappy_pos_reset_epoch';
const AUTO_SYNC_MODE_STORAGE_KEY = 'sappy_pos_auto_sync_mode_v1';

class CrossDeviceSyncService {
  private autoSyncMode: AutoSyncMode = 'live';
  private syncState: SyncState = {
    status: 'offline',
    mode: 'local',
    autoSyncMode: 'live',
    lastSyncedAt: null,
    message: 'Local offline storage active',
    serverVersion: 0,
  };

  private listeners: Set<SyncListener> = new Set();
  private onDataChangedCallback: (() => void) | null = null;
  private syncIntervalId: any = null;
  private isSyncing = false;
  private isResetting = false;
  private activeSyncPromise: Promise<boolean> | null = null;
  private syncQueued = false;
  private queuedIsNewSetup = false;
  private actionDebounceTimer: any = null;
  private broadcastChannel: any = null;
  private readonly instanceId = Math.random().toString(36).slice(2, 10);
  private hasPendingLocalMutation = false;
  private lastSupabaseSyncCompletedAt = 0;
  private lastSupabaseWriteAt = 0;
  private expressEndpointAvailable: boolean | null = null;

  constructor() {
    this.autoSyncMode = this.loadAutoSyncMode();
    this.syncState = {
      ...this.syncState,
      autoSyncMode: this.autoSyncMode,
      message:
        this.autoSyncMode === 'manual'
          ? 'Manual Sync Only — background sync paused (low-bandwidth mode)'
          : this.syncState.message,
    };

    // 1. Subscribe to any storage mutations (actions completed anywhere in the app)
    storageService.subscribeToChanges(() => {
      if (!this.isResetting) {
        this.hasPendingLocalMutation = true;
        if (this.autoSyncMode === 'live') {
          this.triggerActionSync();
        }
      }
    });

    if (typeof window !== 'undefined') {
      // 2. 15-second background interval sync (only active in Live Sync mode)
      if (this.autoSyncMode === 'live') {
        this.startSyncTimer(15000);
      }

      // Network status listeners
      window.addEventListener('online', () => {
        if (!this.isResetting && this.autoSyncMode === 'live') {
          this.triggerActionSync(10);
        }
      });
      window.addEventListener('offline', () => {
        this.updateState({
          status: 'offline',
          message: 'Offline mode: Changes stored locally',
        });
      });

      // Sync on window/tab focus or visibility change (only in Live Sync mode)
      window.addEventListener('focus', () => {
        if (!this.isResetting && this.autoSyncMode === 'live') {
          this.triggerActionSync(10);
        }
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.isResetting && this.autoSyncMode === 'live') {
          this.triggerActionSync(10);
        }
      });

      // BroadcastChannel for instant same-browser cross-tab syncing
      if ('BroadcastChannel' in window) {
        try {
          this.broadcastChannel = new BroadcastChannel('sappy_pos_sync_channel');
          this.broadcastChannel.onmessage = (event: MessageEvent) => {
            if (event.data?.type === 'FORCE_RESET') {
              if (event.data.resetEpoch) {
                this.setClientResetEpoch(Number(event.data.resetEpoch));
              }
              if (this.actionDebounceTimer) {
                clearTimeout(this.actionDebounceTimer);
                this.actionDebounceTimer = null;
              }
              this.syncQueued = false;
              this.queuedIsNewSetup = false;
              storageService.resetEverything(false);
              this.updateState({
                status: 'synced',
                lastSyncedAt: new Date().toISOString(),
                message: 'Factory reset synchronized',
              });
              if (this.onDataChangedCallback) {
                this.onDataChangedCallback();
              }
              return;
            }
            if (event.data?.type === 'SYNC_MODE_CHANGED') {
              const incomingMode: AutoSyncMode = event.data.autoSyncMode === 'manual' ? 'manual' : 'live';
              this.applyAutoSyncMode(incomingMode, false);
              return;
            }
            if (event.data?.type === 'DATA_UPDATED') {
              if (this.isResetting) return;
              if (this.onDataChangedCallback) {
                this.onDataChangedCallback();
              }
              // Only trigger network sync in Live Sync mode
              if (this.autoSyncMode === 'live') {
                this.syncNow();
              }
            }
          };
        } catch {
          // Ignore BroadcastChannel errors in restricted contexts
        }
      }

      // Cross-tab fallback via native storage event (catches reset epoch changes reliably across all tabs)
      window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key === RESET_EPOCH_STORAGE_KEY && e.newValue) {
          const nextEpoch = Number(e.newValue);
          if (Number.isFinite(nextEpoch) && nextEpoch > 0) {
            if (this.actionDebounceTimer) {
              clearTimeout(this.actionDebounceTimer);
              this.actionDebounceTimer = null;
            }
            this.syncQueued = false;
            this.queuedIsNewSetup = false;
            storageService.resetEverything(false);
            this.updateState({
              status: 'synced',
              lastSyncedAt: new Date().toISOString(),
              message: 'Factory reset synchronized',
            });
            if (this.onDataChangedCallback) {
              this.onDataChangedCallback();
            }
          }
        }
      });
    }
  }

  private loadAutoSyncMode(): AutoSyncMode {
    if (typeof window === 'undefined') return 'live';
    try {
      return localStorage.getItem(AUTO_SYNC_MODE_STORAGE_KEY) === 'manual' ? 'manual' : 'live';
    } catch {
      return 'live';
    }
  }

  public getAutoSyncMode(): AutoSyncMode {
    return this.autoSyncMode;
  }

  public setAutoSyncMode(mode: AutoSyncMode): void {
    const cleanMode: AutoSyncMode = mode === 'manual' ? 'manual' : 'live';
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(AUTO_SYNC_MODE_STORAGE_KEY, cleanMode);
      } catch {}
    }
    this.applyAutoSyncMode(cleanMode, true);
  }

  private applyAutoSyncMode(mode: AutoSyncMode, broadcast: boolean): void {
    this.autoSyncMode = mode;

    if (mode === 'manual') {
      this.stopSyncTimer();
      this.syncQueued = false;
      this.queuedIsNewSetup = false;
      this.updateState({
        autoSyncMode: 'manual',
        message: 'Manual Sync Only — background sync paused (low-bandwidth mode)',
      });
    } else {
      this.startSyncTimer(15000);
      this.updateState({
        autoSyncMode: 'live',
        message: 'Live Sync active — syncing automatically',
      });
      if (broadcast && !this.isResetting) {
        this.syncNow();
      }
    }

    if (broadcast && typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const bc = new BroadcastChannel('sappy_pos_sync_channel');
        bc.postMessage({ type: 'SYNC_MODE_CHANGED', autoSyncMode: mode, timestamp: Date.now() });
        bc.close();
      } catch {}
    }
  }

  private getClientResetEpoch(): number {
    if (typeof window === 'undefined') return 0;
    try {
      const raw = localStorage.getItem(RESET_EPOCH_STORAGE_KEY);
      const parsed = raw ? Number(raw) : 0;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private setClientResetEpoch(epoch: number): void {
    if (typeof window === 'undefined' || !Number.isFinite(epoch) || epoch <= 0) return;
    try {
      const current = this.getClientResetEpoch();
      if (epoch > current) {
        localStorage.setItem(RESET_EPOCH_STORAGE_KEY, String(epoch));
      }
    } catch {}
  }

  /**
   * Stops any recurring background auto-sync interval and pending debounced sync.
   */
  public stopSyncTimer() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.actionDebounceTimer) {
      clearTimeout(this.actionDebounceTimer);
      this.actionDebounceTimer = null;
    }
  }

  /**
   * Starts or restarts the recurring background auto-sync timer (defaults to 15 seconds).
   * In Manual Sync Only mode, ensures no background timer is running.
   */
  public startSyncTimer(intervalMs = 15000) {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.autoSyncMode === 'manual') {
      return;
    }
    this.syncIntervalId = setInterval(() => {
      if (!this.isResetting && this.autoSyncMode === 'live') {
        this.syncNow();
      }
    }, intervalMs);
  }

  /**
   * Immediately schedules a sync whenever any action completes (Live Sync mode only).
   * Debounces by default (e.g. 60ms) to coalesce rapid multi-record operations.
   * If a sync is currently in progress, marks a follow-up sync as queued.
   */
  public triggerActionSync(delayMs = 60) {
    if (this.isResetting || this.autoSyncMode === 'manual') return;
    if (this.actionDebounceTimer) {
      clearTimeout(this.actionDebounceTimer);
    }
    this.actionDebounceTimer = setTimeout(() => {
      this.actionDebounceTimer = null;
      if (this.isResetting || this.autoSyncMode === 'manual') return;
      if (this.isSyncing) {
        this.syncQueued = true;
        return;
      }
      this.syncNow();
    }, delayMs);
  }

  public subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    listener(this.syncState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getState(): SyncState {
    return this.syncState;
  }

  public getBackendUrl(): string {
    if (typeof window === 'undefined') return '';
    const custom = localStorage.getItem('sappy_custom_backend_url');
    if (custom && custom.trim()) {
      return custom.trim();
    }
    return '';
  }

  public setBackendUrl(url: string) {
    if (typeof window === 'undefined') return;
    const clean = String(url || '').trim();
    if (clean) {
      localStorage.setItem('sappy_custom_backend_url', clean);
    } else {
      localStorage.removeItem('sappy_custom_backend_url');
    }
    this.expressEndpointAvailable = null;
    this.syncNow();
  }

  private updateState(partial: Partial<SyncState>) {
    this.syncState = { ...this.syncState, ...partial };
    this.listeners.forEach((fn) => fn(this.syncState));
  }

  public broadcastLocalChange() {
    if (this.isResetting) return;
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const bc = new BroadcastChannel('sappy_pos_sync_channel');
        bc.postMessage({ type: 'DATA_UPDATED', timestamp: Date.now() });
        bc.close();
      } catch {}
    }
  }

  public broadcastForceReset(resetEpoch?: number) {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const bc = new BroadcastChannel('sappy_pos_sync_channel');
        bc.postMessage({ type: 'FORCE_RESET', resetEpoch, timestamp: Date.now() });
        bc.close();
      } catch {}
    }
  }

  private initialSyncPromise: Promise<boolean> | null = null;

  /**
   * Fast startup pull of canonical server state.
   * Skipped automatically in Manual Sync Only mode unless forced by an explicit user action.
   */
  public initialSync(force = false): Promise<boolean> {
    if (this.isResetting) {
      return Promise.resolve(false);
    }
    if (!force && this.autoSyncMode === 'manual') {
      return Promise.resolve(false);
    }
    if (this.initialSyncPromise) {
      return this.initialSyncPromise;
    }

    this.initialSyncPromise = (async () => {
      const backend = this.getBackendUrl();
      const urlsToTry: string[] = [];

      if (backend) {
        urlsToTry.push(backend.endsWith('/') ? `${backend}api/pos/state` : `${backend}/api/pos/state`);
      } else if (this.expressEndpointAvailable !== false) {
        urlsToTry.push('/api/pos/state');
      }

      for (const targetUrl of urlsToTry) {
        if (this.isResetting) return false;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 1500);

          const response = await fetch(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (this.isResetting) return false;

          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
              if (!backend) this.expressEndpointAvailable = false;
              continue; // Not JSON (probably HTML 404 page from static host)
            }
            if (!backend) this.expressEndpointAvailable = true;

            const result = await response.json();
            if (this.isResetting) return false;
            if (result.success && result.state) {
              const serverResetEpoch = Number(result.state.resetEpoch || 0);
              const localResetEpoch = this.getClientResetEpoch();
              if (result.state.isReset) {
                if (serverResetEpoch > 0) this.setClientResetEpoch(serverResetEpoch);
                storageService.resetEverything(false);
                this.broadcastForceReset(serverResetEpoch || this.getClientResetEpoch());
              } else if (serverResetEpoch > 0 && localResetEpoch < serverResetEpoch) {
                storageService.resetEverything(false);
                this.setClientResetEpoch(serverResetEpoch);
                storageService.hydrateFromServer(result.state);
              } else {
                if (serverResetEpoch > 0) this.setClientResetEpoch(serverResetEpoch);
                storageService.hydrateFromServer(result.state);
              }

              this.updateState({
                status: 'synced',
                mode: 'server',
                lastSyncedAt: result.serverTime || new Date().toISOString(),
                message: result.state.isReset ? 'Factory reset synchronized' : 'Server synced (Express)',
                serverVersion: result.state.version || this.syncState.serverVersion + 1,
              });

              if (this.onDataChangedCallback) {
                this.onDataChangedCallback();
              }
              if (!result.state.isReset) {
                this.broadcastLocalChange();
              }
              return true;
            }
          }
        } catch {
          // Try fallback url
        }
      }

      if (this.isResetting) return false;
      return this.syncNow();
    })().finally(() => {
      this.initialSyncPromise = null;
    });

    return this.initialSyncPromise;
  }

  private realtimeChannel: any = null;

  private async ensureRealtimeResetListener(): Promise<void> {
    if (typeof window === 'undefined' || this.realtimeChannel || !isSupabaseConfigured()) return;
    try {
      const client = await getSupabase();
      if (!client || this.realtimeChannel) return;

      const handleIncomingRemoteReset = (incomingEpochRaw?: any, resetAt?: string, statusRaw?: string) => {
        if (this.isResetting) return;
        const tombEpoch = Number(incomingEpochRaw || 0);
        const tombStatus = String(statusRaw || 'awaiting_setup');
        const localEpoch = this.getClientResetEpoch();
        if (tombEpoch <= 0 || tombEpoch <= localEpoch) return;

        if (this.actionDebounceTimer) {
          clearTimeout(this.actionDebounceTimer);
          this.actionDebounceTimer = null;
        }
        this.syncQueued = false;
        this.queuedIsNewSetup = false;
        this.setClientResetEpoch(tombEpoch);
        storageService.resetEverything(false);
        if (resetAt) {
          try {
            localStorage.setItem('sappy_pos_last_reset_ack', resetAt);
          } catch {}
        }
        this.broadcastForceReset(tombEpoch);
        this.updateState({
          status: 'synced',
          mode: 'supabase',
          lastSyncedAt: new Date().toISOString(),
          message: 'Factory reset synchronized from another device',
          serverVersion: this.syncState.serverVersion + 1,
        });
        if (this.onDataChangedCallback) {
          this.onDataChangedCallback();
        }
        if (tombStatus === 'setup_completed') {
          void this.syncNow();
        }
      };

      this.realtimeChannel = client
        .channel('sappy-pos-system-control')
        .on('broadcast', { event: 'force_reset' }, (msg: any) => {
          const p = msg?.payload || {};
          handleIncomingRemoteReset(p.resetEpoch, p.resetAt, p.status || 'awaiting_setup');
        })
        .on('broadcast', { event: 'pos_sync_ping' }, (msg: any) => {
          const p = msg?.payload || {};
          if (p.clientId === this.instanceId) return;
          if (this.isResetting || this.autoSyncMode !== 'live') return;
          if (Date.now() - Math.max(this.lastSupabaseSyncCompletedAt, this.lastSupabaseWriteAt) < 3500) return;
          this.triggerActionSync(180);
        })
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'sales',
          },
          () => {
            if (this.isResetting || this.autoSyncMode !== 'live') return;
            if (Date.now() - Math.max(this.lastSupabaseSyncCompletedAt, this.lastSupabaseWriteAt) < 4000) return;
            this.triggerActionSync(220);
          }
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'customers',
            filter: 'id=eq.__system_reset_tombstone__',
          },
          (payload: any) => {
            const notes = payload?.new?.notes;
            if (!notes) return;
            try {
              const parsed = JSON.parse(notes);
              handleIncomingRemoteReset(parsed.resetEpoch, parsed.resetAt, parsed.status);
            } catch {}
          }
        )
        .subscribe();
    } catch {
      // Realtime optional fallback; polling & tombstone still guarantee eventual reset
    }
  }

  /**
   * Initializes background polling (when in Live Sync mode), real-time reset listener, and binds data refresh handler.
   */
  public init(onDataChanged: () => void) {
    this.onDataChangedCallback = onDataChanged;
    void this.ensureRealtimeResetListener();
    if (this.autoSyncMode === 'live') {
      this.startSyncTimer(15000);
    } else {
      this.stopSyncTimer();
    }
  }

  /**
   * Performs an immediate bi-directional sync.
   * Priority 1: Backend Express Server (/api/pos/sync or custom backend URL).
   * Priority 2: Direct Supabase Client (if configured).
   * Fallback: Local offline mode.
   */
  public syncNow(options?: { isNewSetup?: boolean }): Promise<boolean> {
    if (this.isResetting) {
      return Promise.resolve(false);
    }

    if (options?.isNewSetup && this.actionDebounceTimer) {
      clearTimeout(this.actionDebounceTimer);
      this.actionDebounceTimer = null;
    }

    if (this.isSyncing && this.activeSyncPromise) {
      this.syncQueued = true;
      if (options?.isNewSetup) {
        this.queuedIsNewSetup = true;
      }
      return this.activeSyncPromise;
    }

    if (typeof window !== 'undefined' && !navigator.onLine) {
      this.updateState({ status: 'offline', message: 'No internet connection' });
      return Promise.resolve(false);
    }

    this.activeSyncPromise = this.executeSyncNow(options).finally(() => {
      this.activeSyncPromise = null;
    });
    return this.activeSyncPromise;
  }

  private async executeSyncNow(options?: { isNewSetup?: boolean }): Promise<boolean> {
    if (this.isResetting) return false;
    const syncStartedAt = Date.now();
    this.isSyncing = true;
    this.updateState({ status: 'syncing', message: 'Connecting to cloud sync...' });

    const finishSync = (success: boolean) => {
      this.isSyncing = false;
      if (!this.isResetting && this.syncQueued) {
        const nextIsNewSetup = this.queuedIsNewSetup;
        this.syncQueued = false;
        this.queuedIsNewSetup = false;
        setTimeout(() => {
          this.syncNow(nextIsNewSetup ? { isNewSetup: true } : undefined);
        }, 50);
      } else if (this.isResetting) {
        this.syncQueued = false;
        this.queuedIsNewSetup = false;
      }
      return success;
    };

    const didMutateLocally = this.hasPendingLocalMutation || Boolean(options?.isNewSetup);
    this.hasPendingLocalMutation = false;

    // --- STEP 1: Attempt Express Backend Sync ---
    let expressSyncedOk = false;
    let expressSyncUrl: string | null = null;
    const postUrlsToTry: string[] = [];
    const customUrl = this.getBackendUrl();
    if (customUrl) {
      postUrlsToTry.push(customUrl.endsWith('/') ? `${customUrl}api/pos/sync` : `${customUrl}/api/pos/sync`);
    } else if (this.expressEndpointAvailable !== false) {
      postUrlsToTry.push('/api/pos/sync');
    }

    const localData = storageService.getAllData();
    const clientResetEpoch = this.getClientResetEpoch();

    for (const targetUrl of postUrlsToTry) {
      if (this.isResetting) return finishSync(false);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payload: localData,
            isNewSetup: Boolean(options?.isNewSetup),
            clientResetEpoch,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (this.isResetting) return finishSync(false);

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            if (!customUrl) this.expressEndpointAvailable = false;
            continue; // Not JSON (probably HTML 404 page from static host)
          }
          if (!customUrl) this.expressEndpointAvailable = true;

          const result = await response.json();
          if (this.isResetting) return finishSync(false);

          if (result.success && result.state) {
            const serverResetEpoch = Number(result.resetEpoch || result.state.resetEpoch || 0);
            const isResetState = Boolean(result.wasReset || result.state.isReset);

            if (isResetState) {
              if (serverResetEpoch > 0) this.setClientResetEpoch(serverResetEpoch);
              storageService.resetEverything(false);
              this.broadcastForceReset(serverResetEpoch || this.getClientResetEpoch());
            } else if (
              result.replaceLocal ||
              (serverResetEpoch > 0 && clientResetEpoch < serverResetEpoch)
            ) {
              storageService.resetEverything(false);
              if (serverResetEpoch > 0) this.setClientResetEpoch(serverResetEpoch);
              storageService.hydrateFromServer(result.state);
            } else {
              if (serverResetEpoch > 0) this.setClientResetEpoch(serverResetEpoch);
              storageService.hydrateFromServer(result.state, syncStartedAt);
            }

            if (options?.isNewSetup && isSupabaseConfigured()) {
              void getSupabase()
                .then((supa) => {
                  if (!supa) return;
                  return supa
                    .from('customers')
                    .delete()
                    .eq('id', '__system_staff_registry__');
                })
                .catch(() => {});
            }

            expressSyncedOk = true;
            expressSyncUrl = targetUrl;

            this.updateState({
              status: 'synced',
              mode: 'server',
              lastSyncedAt: result.serverTime || new Date().toISOString(),
              message: isResetState
                ? 'Factory reset synchronized'
                : 'Server synced (Express Cloud)',
              serverVersion: result.version || this.syncState.serverVersion + 1,
            });

            if (this.onDataChangedCallback) {
              this.onDataChangedCallback();
            }
            if (!isResetState) {
              this.broadcastLocalChange();
            }

            // If this is a Factory Reset or Supabase is not configured, stop here.
            // Otherwise continue into Step 2 so Express and Supabase (e.g. sappy.work) stay unified!
            if (isResetState || !isSupabaseConfigured()) {
              return finishSync(true);
            }
            break;
          }
        }
      } catch {
        // Try fallback URL
      }
    }

    if (this.isResetting) return finishSync(false);

    // --- STEP 2: Attempt Direct Supabase Sync (All 5 POS Entities) ---
    if (isSupabaseConfigured()) {
      const client = await getSupabase();
      if (this.isResetting) return finishSync(false);
      if (client) {
        try {
          let hasRlsError = false;
          let preservedTombstoneNotes: { resetAt: string; resetEpoch: number } | null = null;

          // 0. Check/Update Factory Reset Tombstone in Supabase (never delete so sleeping peers still reset!)
          try {
            const { data: tombstone } = await client
              .from('customers')
              .select('id, notes')
              .eq('id', '__system_reset_tombstone__')
              .maybeSingle();

            let tombResetAt = new Date().toISOString();
            let tombEpoch = 0;
            let tombStatus = 'awaiting_setup';
            if (tombstone) {
              try {
                const parsed = JSON.parse(tombstone.notes || '{}');
                if (parsed.resetAt) tombResetAt = parsed.resetAt;
                if (parsed.resetEpoch) tombEpoch = Number(parsed.resetEpoch) || 0;
                if (parsed.status) tombStatus = String(parsed.status);
              } catch {}
            }

            if (options?.isNewSetup) {
              const effectiveEpoch = Math.max(tombEpoch, this.getClientResetEpoch());
              if (tombstone || effectiveEpoch > 0) {
                preservedTombstoneNotes = {
                  resetAt: tombResetAt,
                  resetEpoch: effectiveEpoch || Date.now(),
                };
              }
            } else if (tombstone) {
              const ackKey = 'sappy_pos_last_reset_ack';
              const lastAck = typeof window !== 'undefined' ? localStorage.getItem(ackKey) : null;
              const localEpoch = this.getClientResetEpoch();
              const isNewerEpoch = tombEpoch > 0 && tombEpoch > localEpoch;
              const isUnackedAwaiting = tombStatus !== 'setup_completed' && lastAck !== tombResetAt;

              if (isNewerEpoch || isUnackedAwaiting) {
                if (tombEpoch > 0) this.setClientResetEpoch(tombEpoch);
                storageService.resetEverything(false);
                if (typeof window !== 'undefined') {
                  localStorage.setItem(ackKey, tombResetAt);
                }
                this.broadcastForceReset(tombEpoch || this.getClientResetEpoch());

                if (tombStatus !== 'setup_completed') {
                  this.updateState({
                    status: 'synced',
                    mode: 'supabase',
                    lastSyncedAt: new Date().toISOString(),
                    message: 'Factory reset synchronized from cloud',
                    serverVersion: this.syncState.serverVersion + 1,
                  });
                  if (this.onDataChangedCallback) {
                    this.onDataChangedCallback();
                  }
                  return finishSync(true);
                }
                // If setup_completed on peer device: local old data is now wiped clean; continue below to pull new setup!
              } else if (
                tombStatus !== 'setup_completed' &&
                !storageService.hasUsers() &&
                storageService.getProducts().length === 0
              ) {
                // Already acknowledged this reset; skip pushing empty/stale data while awaiting setup
                this.updateState({
                  status: 'synced',
                  mode: 'supabase',
                  lastSyncedAt: new Date().toISOString(),
                  message: 'Store awaiting initial setup',
                });
                return finishSync(true);
              } else if (tombStatus !== 'setup_completed' && storageService.hasUsers()) {
                // Local device set up a new store since the reset; mark tombstone as setup_completed
                await client.from('customers').upsert({
                  id: '__system_reset_tombstone__',
                  name: '__SYSTEM_RESET_TOMBSTONE__',
                  phone: '+251 00 000 0000',
                  credit_balance: 0,
                  credit_limit: 0,
                  total_purchased: 0,
                  notes: JSON.stringify({
                    resetAt: tombResetAt,
                    resetEpoch: Math.max(tombEpoch, this.getClientResetEpoch()) || Date.now(),
                    status: 'setup_completed',
                    setupCompletedAt: new Date().toISOString(),
                  }),
                });
              }
            }
          } catch (tombErr) {
            console.warn('Supabase reset tombstone check notice:', tombErr);
          }

          // 0b. When completing First-Time Setup after a reset, ensure remote Supabase tables
          // are clean BEFORE pushing new data and skip pulling any leftover remote rows.
          if (options?.isNewSetup) {
            const resetTablesById = [
              'sale_items',
              'credit_payments',
              'sales',
              'expenses',
              'products',
              'customers',
              'app_users',
              'store_users',
            ];
            for (const tableName of resetTablesById) {
              try {
                await client.from(tableName).delete().not('id', 'is', null);
                const { data: remaining } = await client.from(tableName).select('id');
                if (remaining && remaining.length > 0) {
                  const ids = remaining.map((r: any) => r.id).filter((id: any) => id !== null && id !== undefined);
                  for (let i = 0; i < ids.length; i += 40) {
                    await client.from(tableName).delete().in('id', ids.slice(i, i + 40));
                  }
                }
              } catch {}
            }
            try {
              await client.from('store_settings').delete().not('key', 'is', null);
            } catch {}

            if (preservedTombstoneNotes) {
              try {
                await client.from('customers').upsert({
                  id: '__system_reset_tombstone__',
                  name: '__SYSTEM_RESET_TOMBSTONE__',
                  phone: '+251 00 000 0000',
                  credit_balance: 0,
                  credit_limit: 0,
                  total_purchased: 0,
                  notes: JSON.stringify({
                    resetAt: preservedTombstoneNotes.resetAt,
                    resetEpoch: preservedTombstoneNotes.resetEpoch,
                    status: 'setup_completed',
                    setupCompletedAt: new Date().toISOString(),
                  }),
                });
              } catch {}
            }
          }

          // 1-6. Parallel Supabase Pull + Diff-Only Parallel Push
          if (this.isResetting) return finishSync(false);

          const deletedCustIds = storageService.getDeletedCustomerIds().filter((id) => !id.startsWith('__system_'));
          const delSet = new Set(deletedCustIds);

          let remoteProductsRaw: any[] = [];
          let remoteCustomersRaw: any[] = [];
          let remoteSalesRaw: any[] = [];
          let remotePaymentsRaw: any[] = [];
          let remoteExpensesRaw: any[] = [];
          let remoteUsersFound: any[] = [];
          let tableSyncSucceeded = false;

          if (!options?.isNewSetup) {
            const [prodRes, custRes, saleRes, payRes, expRes, userRes] = await Promise.allSettled([
              client.from('products').select('*'),
              client.from('customers').select('*'),
              client.from('sales').select('*'),
              client.from('credit_payments').select('*'),
              client.from('expenses').select('*'),
              client.from('app_users').select('*'),
            ]);
            if (this.isResetting) return finishSync(false);

            if (prodRes.status === 'fulfilled' && Array.isArray(prodRes.value.data)) {
              remoteProductsRaw = prodRes.value.data;
            }
            if (custRes.status === 'fulfilled' && Array.isArray(custRes.value.data)) {
              remoteCustomersRaw = custRes.value.data;
            }
            if (saleRes.status === 'fulfilled' && Array.isArray(saleRes.value.data)) {
              remoteSalesRaw = saleRes.value.data;
            }
            if (payRes.status === 'fulfilled' && Array.isArray(payRes.value.data)) {
              remotePaymentsRaw = payRes.value.data;
            }
            if (expRes.status === 'fulfilled' && Array.isArray(expRes.value.data)) {
              remoteExpensesRaw = expRes.value.data;
            }
            if (userRes.status === 'fulfilled' && !userRes.value.error && Array.isArray(userRes.value.data)) {
              tableSyncSucceeded = true;
              remoteUsersFound = userRes.value.data.map((u: any) => ({
                id: u.id,
                email: u.email,
                fullName: u.full_name || u.fullName || u.email.split('@')[0],
                role: u.role || 'owner',
                storeName: u.store_name || u.storeName || 'Sappy Stationary',
                phone: u.phone || undefined,
                pinCode: u.pin_code || u.pinCode || undefined,
                password: u.password !== undefined ? u.password : undefined,
                status: u.status || 'active',
                createdAt: u.created_at || u.createdAt || new Date().toISOString(),
                updatedAt: u.updated_at || u.updatedAt || undefined,
                lastLoginAt: u.last_login_at || u.lastLoginAt || undefined,
                notes: u.notes || undefined,
              }));
            }

            // Merge Products
            const mappedProducts = remoteProductsRaw.map((p: any) => ({
              id: p.id,
              sku: p.sku,
              barcode: p.barcode || '',
              name: p.name,
              category: p.category,
              costPrice: Number(p.cost_price || 0),
              sellingPrice: Number(p.selling_price || 0),
              stockLevel: Number(p.stock_level || 0),
              lowStockThreshold: Number(p.low_stock_threshold || 5),
              unit: p.unit || 'pcs',
              description: p.description || '',
              updatedAt: p.updated_at || undefined,
            }));
            if (mappedProducts.length > 0) {
              storageService.mergeProductsFromRemote(mappedProducts, syncStartedAt);
            }

            // Merge Customers + fallback staff registry
            const staffRegRecord = remoteCustomersRaw.find((c: any) => c.id === '__system_staff_registry__');
            if (!tableSyncSucceeded && staffRegRecord && staffRegRecord.notes) {
              try {
                const parsedStaff = JSON.parse(staffRegRecord.notes);
                if (Array.isArray(parsedStaff) && parsedStaff.length > 0) {
                  remoteUsersFound = parsedStaff;
                }
              } catch {}
            }
            const mappedCustomers = remoteCustomersRaw
              .filter((c: any) => !delSet.has(c.id) && !c.id.startsWith('__system_'))
              .map((c: any) => decodeCustomerFromRemoteRow(c));
            if (mappedCustomers.length > 0) {
              storageService.mergeCustomersFromRemote(mappedCustomers, syncStartedAt);
            }

            // Merge Sales (preserving full refund/return metadata)
            if (remoteSalesRaw.length > 0) {
              const mappedSales: Sale[] = remoteSalesRaw.map((s: any) => decodeSaleFromRemoteRow(s));
              const localSales = storageService.getSales();
              const salesMap = new Map(localSales.map((s) => [s.id, s]));
              for (const rs of mappedSales) {
                const existing = salesMap.get(rs.id);
                if (existing && existing.isReturned && !rs.isReturned) {
                  salesMap.set(rs.id, { ...rs, ...existing, isReturned: true, status: 'returned' });
                } else if (rs.isReturned && existing) {
                  salesMap.set(rs.id, { ...existing, ...rs, isReturned: true, status: 'returned' });
                } else {
                  salesMap.set(rs.id, rs);
                }
              }
              storageService.hydrateFromServer({ sales: Array.from(salesMap.values()) }, syncStartedAt);
            }

            // Merge Credit Payments
            if (remotePaymentsRaw.length > 0) {
              const mappedPayments: CreditPayment[] = remotePaymentsRaw.map((p: any) => ({
                id: p.id,
                customerId: p.customer_id,
                customerName: p.customer_name,
                saleId: p.sale_id || undefined,
                amount: Number(p.amount || 0),
                paymentMethod: p.payment_method || 'cash',
                timestamp: p.timestamp || new Date().toISOString(),
                receiptNumber: p.receipt_number,
                notes: p.notes || undefined,
              }));
              const localPayments = storageService.getCreditPayments();
              const payMap = new Map(localPayments.map((p) => [p.id, p]));
              for (const rp of mappedPayments) {
                payMap.set(rp.id, rp);
              }
              storageService.hydrateFromServer({ creditPayments: Array.from(payMap.values()) });
            }

            // Merge Expenses
            if (remoteExpensesRaw.length > 0) {
              const mappedExpenses: Expense[] = remoteExpensesRaw.map((e: any) => ({
                id: e.id,
                date: e.date,
                category: e.category,
                title: e.title,
                amount: Number(e.amount || 0),
                paymentMethod: e.payment_method || 'cash',
                payee: e.payee,
                receiptNumber: e.receipt_number || undefined,
                notes: e.notes || undefined,
                createdAt: e.created_at || new Date().toISOString(),
              }));
              const localExpenses = storageService.getExpenses();
              const expMap = new Map(localExpenses.map((e) => [e.id, e]));
              for (const re of mappedExpenses) {
                expMap.set(re.id, re);
              }
              storageService.hydrateFromServer({ expenses: Array.from(expMap.values()) });
            }

            // Merge Users
            if (remoteUsersFound.length > 0) {
              storageService.hydrateFromServer({ users: remoteUsersFound });
            }
          }

          if (this.isResetting) return finishSync(false);

          // Determine only the tables that have local changes to push
          const currentProducts = storageService.getProducts();
          const currentCustomers = storageService.getCustomers().filter((c) => !c.id.startsWith('__system_'));
          const currentSales = storageService.getSales();
          const currentPayments = storageService.getCreditPayments();
          const currentExpenses = storageService.getExpenses();
          const currentUsers = storageService.getUsers();

          const remoteProdMap = new Map(remoteProductsRaw.map((p: any) => [p.id, p]));
          const productsNeedPush =
            Boolean(options?.isNewSetup) ||
            (currentProducts.length > 0 &&
              (didMutateLocally ||
                currentProducts.some((p) => {
                  const rp = remoteProdMap.get(p.id);
                  if (!rp) return true;
                  return (
                    Number(rp.stock_level || 0) !== Number(p.stockLevel || 0) ||
                    Number(rp.selling_price || 0) !== Number(p.sellingPrice || 0) ||
                    (p.updatedAt || '') > (rp.updated_at || '')
                  );
                })));

          const remoteCustMap = new Map(
            remoteCustomersRaw
              .filter((c: any) => !String(c.id).startsWith('__system_'))
              .map((c: any) => [c.id, decodeCustomerFromRemoteRow(c)])
          );
          const customersNeedPush =
            Boolean(options?.isNewSetup) ||
            (currentCustomers.length > 0 &&
              (didMutateLocally ||
                currentCustomers.some((c) => {
                  const rc = remoteCustMap.get(c.id);
                  if (!rc) return true;
                  return (
                    Number(rc.creditBalance || 0) !== Number(c.creditBalance || 0) ||
                    Number(rc.totalPurchased || 0) !== Number(c.totalPurchased || 0) ||
                    (c.updatedAt || '') > (rc.updatedAt || '')
                  );
                })));

          const remoteSalesMap = new Map(
            remoteSalesRaw.map((s: any) => [s.id, decodeSaleFromRemoteRow(s)])
          );
          const salesNeedPush =
            Boolean(options?.isNewSetup) ||
            (currentSales.length > 0 &&
              (didMutateLocally ||
                currentSales.some((s) => {
                  const rs = remoteSalesMap.get(s.id);
                  if (!rs) return true;
                  return (
                    Boolean(s.isReturned) !== Boolean(rs.isReturned) ||
                    Number(s.paidAmount || 0) !== Number(rs.paidAmount || 0) ||
                    Boolean(s.isCreditPaid) !== Boolean(rs.isCreditPaid)
                  );
                })));

          const remotePayIds = new Set(remotePaymentsRaw.map((p: any) => p.id));
          const paymentsNeedPush =
            Boolean(options?.isNewSetup) ||
            (currentPayments.length > 0 && (didMutateLocally || currentPayments.some((p) => !remotePayIds.has(p.id))));

          const remoteExpIds = new Set(remoteExpensesRaw.map((e: any) => e.id));
          const expensesNeedPush =
            Boolean(options?.isNewSetup) ||
            (currentExpenses.length > 0 && (didMutateLocally || currentExpenses.some((e) => !remoteExpIds.has(e.id))));

          const remoteUserMap = new Map(remoteUsersFound.map((u: any) => [u.id, u]));
          const usersNeedPush =
            Boolean(options?.isNewSetup) ||
            (currentUsers.length > 0 &&
              (didMutateLocally ||
                currentUsers.some((u) => {
                  const ru = remoteUserMap.get(u.id);
                  return !ru || (u.updatedAt || '') > (ru.updatedAt || '');
                })));

          const writeTasks: Array<Promise<void>> = [];
          this.lastSupabaseWriteAt = Date.now();

          if (deletedCustIds.length > 0) {
            writeTasks.push(
              Promise.resolve(
                client.from('customers').delete().in('id', deletedCustIds)
              )
                .then(() => {})
                .catch(() => {})
            );
          }

          if (productsNeedPush && currentProducts.length > 0) {
            writeTasks.push(
              Promise.resolve(
                client.from('products').upsert(
                  currentProducts.map((p) => ({
                    id: p.id,
                    sku: p.sku,
                    barcode: p.barcode || '',
                    name: p.name,
                    category: p.category,
                    cost_price: p.costPrice,
                    selling_price: p.sellingPrice,
                    stock_level: p.stockLevel,
                    low_stock_threshold: p.lowStockThreshold,
                    unit: p.unit,
                    description: p.description,
                    updated_at: p.updatedAt || new Date().toISOString(),
                  }))
                )
              )
                .then(({ error: prodErr }) => {
                  if (prodErr && (prodErr.code === '42501' || prodErr.message?.includes('row-level security'))) {
                    hasRlsError = true;
                  }
                })
                .catch((pErr) => console.warn('Supabase product sync notice:', pErr))
            );
          }

          if (customersNeedPush && currentCustomers.length > 0) {
            writeTasks.push(
              Promise.resolve(
                client.from('customers').upsert(
                  currentCustomers.map((c) => ({
                    id: c.id,
                    name: c.name,
                    company_name: c.companyName || null,
                    phone: c.phone,
                    email: c.email || null,
                    address: c.address || null,
                    tax_number: c.taxNumber || null,
                    credit_balance: c.creditBalance,
                    credit_limit: c.creditLimit,
                    total_purchased: c.totalPurchased,
                    notes: encodeCustomerNotesWithMeta(c),
                  }))
                )
              )
                .then(({ error: custErr }) => {
                  if (custErr && (custErr.code === '42501' || custErr.message?.includes('row-level security'))) {
                    hasRlsError = true;
                  }
                })
                .catch((cErr) => console.warn('Supabase customer sync notice:', cErr))
            );
          }

          if (salesNeedPush && currentSales.length > 0) {
            writeTasks.push(
              Promise.resolve(
                client.from('sales').upsert(
                  currentSales.map((s) => ({
                    id: s.id,
                    invoice_number: s.invoiceNumber,
                    timestamp: s.timestamp,
                    customer_id: s.customerId || null,
                    customer_name: s.customerName,
                    customer_phone: s.customerPhone || null,
                    customer_email: s.customerEmail || null,
                    customer_address: s.customerAddress || null,
                    subtotal: s.subtotal,
                    tax_rate: s.taxRate,
                    tax_amount: s.taxAmount,
                    discount_amount: s.discountAmount,
                    total_amount: s.totalAmount,
                    total_cost: s.totalCost,
                    gross_profit: s.grossProfit,
                    payment_method: s.paymentMethod,
                    amount_tendered: s.amountTendered,
                    change_given: s.changeGiven,
                    is_credit_paid: s.isCreditPaid,
                    credit_due_date: s.creditDueDate || null,
                    paid_amount: s.paidAmount || 0,
                    notes: encodeSaleNotesWithReturnMetadata(s),
                    items: s.items || [],
                  }))
                )
              )
                .then(({ error: salesErr }) => {
                  if (salesErr && (salesErr.code === '42501' || salesErr.message?.includes('row-level security'))) {
                    hasRlsError = true;
                  }
                })
                .catch((sErr) => console.warn('Supabase sales sync notice:', sErr))
            );
          }

          if (paymentsNeedPush && currentPayments.length > 0) {
            writeTasks.push(
              Promise.resolve(
                client.from('credit_payments').upsert(
                  currentPayments.map((p) => ({
                    id: p.id,
                    customer_id: p.customerId,
                    customer_name: p.customerName,
                    sale_id: p.saleId || null,
                    amount: p.amount,
                    payment_method: p.paymentMethod,
                    timestamp: p.timestamp,
                    receipt_number: p.receiptNumber,
                    notes: p.notes || null,
                  }))
                )
              )
                .then(({ error: payErr }) => {
                  if (payErr && (payErr.code === '42501' || payErr.message?.includes('row-level security'))) {
                    hasRlsError = true;
                  }
                })
                .catch((pErr) => console.warn('Supabase credit payments sync notice:', pErr))
            );
          }

          if (expensesNeedPush && currentExpenses.length > 0) {
            writeTasks.push(
              Promise.resolve(
                client.from('expenses').upsert(
                  currentExpenses.map((e) => ({
                    id: e.id,
                    date: e.date,
                    category: e.category,
                    title: e.title,
                    amount: e.amount,
                    payment_method: e.paymentMethod,
                    payee: e.payee,
                    receipt_number: e.receiptNumber || null,
                    notes: e.notes || null,
                  }))
                )
              )
                .then(({ error: expErr }) => {
                  if (expErr && (expErr.code === '42501' || expErr.message?.includes('row-level security'))) {
                    hasRlsError = true;
                  }
                })
                .catch((eErr) => console.warn('Supabase expenses sync notice:', eErr))
            );
          }

          if (usersNeedPush && currentUsers.length > 0) {
            if (tableSyncSucceeded) {
              writeTasks.push(
                Promise.resolve(
                  client.from('app_users').upsert(
                    currentUsers.map((u) => ({
                      id: u.id,
                      email: u.email,
                      full_name: u.fullName,
                      role: u.role,
                      store_name: u.storeName,
                      phone: u.phone || null,
                      pin_code: u.pinCode || null,
                      status: u.status,
                      notes: u.notes || null,
                      updated_at: u.updatedAt || new Date().toISOString(),
                    }))
                  )
                )
                  .then(() => {})
                  .catch(() => {})
              );
            }
            writeTasks.push(
              Promise.resolve(
                client.from('customers').upsert({
                  id: '__system_staff_registry__',
                  name: '__SYSTEM_STAFF_REGISTRY__',
                  phone: '+251 00 000 0000',
                  credit_balance: 0,
                  credit_limit: 0,
                  total_purchased: 0,
                  notes: JSON.stringify(currentUsers),
                })
              )
                .then(() => {})
                .catch((regSaveErr) => console.warn('System staff registry save notice:', regSaveErr))
            );
          }

          if (writeTasks.length > 0) {
            await Promise.allSettled(writeTasks);
          }

          if (hasRlsError) {
            this.updateState({
              status: 'error',
              mode: 'supabase',
              message: 'Supabase RLS active (42501): Run 1-click RLS fix in Cloud Sync',
            });
            return finishSync(false);
          }

          this.lastSupabaseSyncCompletedAt = Date.now();

          // If Express also synced in Step 1, mirror the merged post-Supabase state back to Express immediately
          if (expressSyncedOk && expressSyncUrl && !this.isResetting && !options?.isNewSetup) {
            try {
              const mirrorController = new AbortController();
              const mirrorTimeout = setTimeout(() => mirrorController.abort(), 2000);
              await fetch(expressSyncUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  payload: storageService.getAllData(),
                  isNewSetup: false,
                  clientResetEpoch: this.getClientResetEpoch(),
                }),
                signal: mirrorController.signal,
              }).catch(() => {});
              clearTimeout(mirrorTimeout);
            } catch {}
          }

          if (didMutateLocally && this.realtimeChannel && !this.isResetting) {
            try {
              void this.realtimeChannel.send({
                type: 'broadcast',
                event: 'pos_sync_ping',
                payload: { clientId: this.instanceId, ts: Date.now() },
              });
            } catch {}
          }

          this.updateState({
            status: 'synced',
            mode: 'supabase',
            lastSyncedAt: new Date().toISOString(),
            message: 'Cloud synced (Supabase Live)',
            serverVersion: this.syncState.serverVersion + 1,
          });

          if (this.onDataChangedCallback) {
            this.onDataChangedCallback();
          }
          this.broadcastLocalChange();
          return finishSync(true);
        } catch (supabaseErr: any) {
          console.warn('Supabase sync warning:', supabaseErr?.message || supabaseErr);
        }
      }
    }

    if (expressSyncedOk) {
      return finishSync(true);
    }

    // --- STEP 3: Fallback to Local Offline Storage ---
    this.updateState({
      status: 'offline',
      mode: 'local',
      message: 'Running in Local Mode (Standalone)',
    });
    return finishSync(false);
  }

  /**
   * Resets both local and remote state cleanly with a reset lock and epoch barrier
   * so no in-flight sync or stale peer tab can resurrect deleted inventory.
   */
  public async resetAllDevices(): Promise<boolean> {
    this.isResetting = true;
    if (this.actionDebounceTimer) {
      clearTimeout(this.actionDebounceTimer);
      this.actionDebounceTimer = null;
    }
    this.syncQueued = false;
    this.queuedIsNewSetup = false;

    let resetEpoch = Math.max(Date.now(), this.getClientResetEpoch() + 1);
    this.setClientResetEpoch(resetEpoch);

    // 1. Wipe local storage IMMEDIATELY and broadcast FORCE_RESET so no timer/peer tab can re-upload old products
    storageService.resetEverything(false);
    this.broadcastForceReset(resetEpoch);
    if (this.onDataChangedCallback) {
      this.onDataChangedCallback();
    }

    try {
      // 2. Wait briefly for any in-flight sync to settle so no stale request lands after our wipe
      const inflight: Promise<unknown>[] = [];
      if (this.activeSyncPromise) inflight.push(this.activeSyncPromise.catch(() => {}));
      if (this.initialSyncPromise) inflight.push(this.initialSyncPromise.catch(() => {}));
      if (inflight.length > 0) {
        await Promise.race([
          Promise.allSettled(inflight),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      }

      // 3. Wipe remote Express backend stores (passes Supabase creds and waits up to 15s for full cloud wipe)
      const resetUrlsToTry: string[] = [];
      const customUrl = this.getBackendUrl();
      if (customUrl) {
        resetUrlsToTry.push(customUrl.endsWith('/') ? `${customUrl}api/pos/reset` : `${customUrl}/api/pos/reset`);
      } else {
        resetUrlsToTry.push('/api/pos/reset');
      }

      const supaCreds = getSupabaseCredentials();
      await Promise.allSettled(
        resetUrlsToTry.map(async (targetUrl) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          try {
            const resp = await fetch(targetUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                supabaseUrl: supaCreds.url,
                supabaseAnonKey: supaCreds.anonKey,
              }),
              signal: controller.signal,
            });
            if (resp.ok) {
              const contentType = resp.headers.get('content-type') || '';
              if (contentType.includes('application/json')) {
                const json = await resp.json();
                const srvEpoch = Number(json?.resetEpoch || 0);
                if (srvEpoch > resetEpoch) {
                  resetEpoch = srvEpoch;
                  this.setClientResetEpoch(resetEpoch);
                }
              }
            }
          } catch {
            // Ignore unreachable fallback endpoint
          } finally {
            clearTimeout(timeoutId);
          }
        })
      );

      // 4. Wipe live Supabase tables (if configured) in FK-safe order with verified batch fallback
      if (isSupabaseConfigured()) {
        const client = await getSupabase();
        if (client) {
          try {
            const tablesById = [
              'sale_items',
              'credit_payments',
              'sales',
              'expenses',
              'products',
              'customers',
              'app_users',
              'store_users',
            ];
            for (const tableName of tablesById) {
              try {
                await client.from(tableName).delete().not('id', 'is', null);
                const { data: remaining } = await client.from(tableName).select('id');
                if (remaining && remaining.length > 0) {
                  const ids = remaining.map((r: any) => r.id).filter((id: any) => id !== null && id !== undefined);
                  for (let i = 0; i < ids.length; i += 40) {
                    await client.from(tableName).delete().in('id', ids.slice(i, i + 40));
                  }
                }
              } catch {}
            }

            try {
              await client.from('customers').delete().eq('id', '__system_staff_registry__');
            } catch {}

            try {
              await client.from('store_settings').delete().not('key', 'is', null);
            } catch {}

            // Write a factory reset tombstone so peer devices wipe cleanly instead of re-uploading stale data
            const resetAt = new Date().toISOString();
            try {
              await client.from('customers').upsert({
                id: '__system_reset_tombstone__',
                name: '__SYSTEM_RESET_TOMBSTONE__',
                phone: '+251 00 000 0000',
                credit_balance: 0,
                credit_limit: 0,
                total_purchased: 0,
                notes: JSON.stringify({ resetAt, resetEpoch, status: 'awaiting_setup' }),
              });
              if (typeof window !== 'undefined') {
                localStorage.setItem('sappy_pos_last_reset_ack', resetAt);
              }
            } catch {}

            // Broadcast instant force_reset signal to all currently open devices via Supabase Realtime
            try {
              const ctrlChannel = this.realtimeChannel || client.channel('sappy-pos-system-control');
              await ctrlChannel.send({
                type: 'broadcast',
                event: 'force_reset',
                payload: { resetEpoch, resetAt, status: 'awaiting_setup' },
              });
            } catch {}
          } catch (supaErr) {
            console.warn('Supabase reset warning:', supaErr);
          }
        }
      }
    } finally {
      // 5. Final ironclad local wipe & release reset lock
      this.setClientResetEpoch(resetEpoch);
      storageService.resetEverything(false);
      this.broadcastForceReset(resetEpoch);
      this.isResetting = false;

      this.updateState({
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        message: 'All data, users, and catalog records permanently wiped clean across all devices',
      });

      if (this.onDataChangedCallback) {
        this.onDataChangedCallback();
      }
    }

    return true;
  }
}

export const crossDeviceSyncService = new CrossDeviceSyncService();
