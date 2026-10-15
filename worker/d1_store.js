// The store interface the relay expects, backed by Cloudflare D1.
//
// Method for method the same contract as JsonNotificationStore, so the shared
// logic in relay_core.js cannot tell the two apart. Where that store merged
// plain objects, this one merges the JSON document and rewrites the few
// columns the indexes need.

const parse = (row) => (row ? JSON.parse(row.doc) : null);
const parseAll = (result) => (result.results || []).map((row) => JSON.parse(row.doc));

export class D1NotificationStore {
  constructor(db) {
    this.db = db;
  }

  async createPairing(pairing) {
    await this.db
      .prepare('INSERT INTO pairings (id, pairing_code, status, doc) VALUES (?, ?, ?, ?)')
      .bind(pairing.id, pairing.pairingCode, pairing.status, JSON.stringify(pairing))
      .run();
    return pairing;
  }

  async getPairing(pairingId) {
    return parse(
      await this.db.prepare('SELECT doc FROM pairings WHERE id = ?').bind(pairingId).first(),
    );
  }

  async findPendingPairing(pairingId, pairingCode, isExpired) {
    // The id is optional on purpose: the PWA link carries both, but a person
    // typing the code into the Android app only has the code.
    const row = pairingId
      ? await this.db
          .prepare('SELECT doc FROM pairings WHERE id = ? AND pairing_code = ?')
          .bind(pairingId, pairingCode)
          .first()
      : await this.db
          .prepare(
            'SELECT doc FROM pairings WHERE pairing_code = ? AND status = ? LIMIT 1',
          )
          .bind(pairingCode, 'pending')
          .first();

    const pairing = parse(row);
    if (!pairing) return null;
    if (pairing.status !== 'pending') return null;
    if (isExpired(pairing.expiresAt)) return null;
    return pairing;
  }

  async expirePairing(pairingId) {
    const pairing = await this.getPairing(pairingId);
    if (!pairing) return null;
    pairing.status = 'expired';
    await this.db
      .prepare('UPDATE pairings SET status = ?, doc = ? WHERE id = ?')
      .bind('expired', JSON.stringify(pairing), pairingId)
      .run();
    return pairing;
  }

  async linkDevice({ pairingId, device, subscription }) {
    const pairing = await this.getPairing(pairingId);
    if (!pairing) throw new Error('Pairing session not found.');

    pairing.status = 'linked';
    pairing.deviceId = device.id;
    pairing.linkedAt = device.linkedAt;

    const statements = [
      this.db
        .prepare(
          'INSERT INTO devices (id, control_token_hash, linked_at, doc) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET control_token_hash = excluded.control_token_hash, ' +
            'linked_at = excluded.linked_at, doc = excluded.doc',
        )
        .bind(device.id, device.controlTokenHash || null, device.linkedAt, JSON.stringify(device)),
      this.db
        .prepare('UPDATE pairings SET status = ?, doc = ? WHERE id = ?')
        .bind('linked', JSON.stringify(pairing), pairingId),
    ];

    if (subscription && subscription.endpoint) {
      const record = {
        deviceId: device.id,
        subscription,
        endpoint: subscription.endpoint,
        enabled: true,
        createdAt: device.linkedAt,
        lastSeenAt: device.lastSeenAt,
      };
      statements.push(
        this.db
          .prepare(
            'INSERT INTO subscriptions (device_id, doc) VALUES (?, ?) ' +
              'ON CONFLICT(device_id) DO UPDATE SET doc = excluded.doc',
          )
          .bind(device.id, JSON.stringify(record)),
      );
    }

    await this.db.batch(statements);
    return device;
  }

  async listDevices() {
    return parseAll(
      await this.db.prepare('SELECT doc FROM devices ORDER BY linked_at DESC').all(),
    );
  }

  async updateDevice(deviceId, patch) {
    const device = parse(
      await this.db.prepare('SELECT doc FROM devices WHERE id = ?').bind(deviceId).first(),
    );
    if (!device) return null;
    const updated = { ...device, ...patch };
    await this.db
      .prepare('UPDATE devices SET doc = ? WHERE id = ?')
      .bind(JSON.stringify(updated), deviceId)
      .run();
    return updated;
  }

  async deleteDevice(deviceId) {
    await this.db.batch([
      this.db.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId),
      this.db.prepare('DELETE FROM subscriptions WHERE device_id = ?').bind(deviceId),
    ]);
    return null;
  }

  async findDeviceByControlTokenHash(tokenHash) {
    if (!tokenHash) return null;
    return parse(
      await this.db
        .prepare('SELECT doc FROM devices WHERE control_token_hash = ? LIMIT 1')
        .bind(tokenHash)
        .first(),
    );
  }

  async getSubscription(deviceId) {
    return parse(
      await this.db
        .prepare('SELECT doc FROM subscriptions WHERE device_id = ?')
        .bind(deviceId)
        .first(),
    );
  }

  async touchSubscription(deviceId, timestamp) {
    return this._patchSubscription(deviceId, { lastSeenAt: timestamp });
  }

  async disableSubscription(deviceId, timestamp) {
    return this._patchSubscription(deviceId, {
      enabled: false,
      disabledAt: timestamp,
    });
  }

  async _patchSubscription(deviceId, patch) {
    const record = await this.getSubscription(deviceId);
    if (!record) return null;
    const updated = { ...record, ...patch };
    await this.db
      .prepare('UPDATE subscriptions SET doc = ? WHERE device_id = ?')
      .bind(JSON.stringify(updated), deviceId)
      .run();
    return updated;
  }

  async upsertCommandRun(run) {
    await this.db
      .prepare(
        'INSERT INTO command_runs (run_id, updated_at, doc) VALUES (?, ?, ?) ' +
          'ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at, doc = excluded.doc',
      )
      .bind(run.runId, run.updatedAt || run.finishedAt || run.startedAt || '', JSON.stringify(run))
      .run();
    return run;
  }

  async getCommandRun(runId) {
    return parse(
      await this.db.prepare('SELECT doc FROM command_runs WHERE run_id = ?').bind(runId).first(),
    );
  }

  async cleanupCommandRuns({ olderThan, maxCount }) {
    await this.db
      .prepare('DELETE FROM command_runs WHERE updated_at != ? AND updated_at < ?')
      .bind('', new Date(olderThan).toISOString())
      .run();
    // Keep the newest maxCount; SQLite has no LIMIT on DELETE by default.
    await this.db
      .prepare(
        'DELETE FROM command_runs WHERE run_id NOT IN ' +
          '(SELECT run_id FROM command_runs ORDER BY updated_at DESC LIMIT ?)',
      )
      .bind(maxCount)
      .run();
  }

  async upsertDesktopState(desktop) {
    const existing = await this.getDesktopState(desktop.desktopId);
    const merged = { ...(existing || {}), ...desktop };
    await this.db
      .prepare(
        'INSERT INTO desktop_states (desktop_id, last_seen_at, doc) VALUES (?, ?, ?) ' +
          'ON CONFLICT(desktop_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, ' +
          'doc = excluded.doc',
      )
      .bind(merged.desktopId, merged.lastSeenAt || '', JSON.stringify(merged))
      .run();
    return merged;
  }

  async getDesktopState(desktopId) {
    return parse(
      await this.db
        .prepare('SELECT doc FROM desktop_states WHERE desktop_id = ?')
        .bind(desktopId)
        .first(),
    );
  }

  async listDesktopStates() {
    return parseAll(
      await this.db
        .prepare('SELECT doc FROM desktop_states ORDER BY last_seen_at DESC')
        .all(),
    );
  }

  async createRemoteCommand(command) {
    await this.db
      .prepare(
        'INSERT INTO remote_commands ' +
          '(command_id, status, lane, target_desktop_id, created_at, doc) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        command.commandId,
        command.status,
        command.lane || 'release',
        command.targetDesktopId || '',
        command.createdAt || '',
        JSON.stringify(command),
      )
      .run();
    return command;
  }

  async getRemoteCommand(commandId) {
    return parse(
      await this.db
        .prepare('SELECT doc FROM remote_commands WHERE command_id = ?')
        .bind(commandId)
        .first(),
    );
  }

  async listRemoteCommands({ status, targetDesktopId, lane, limit = 20 } = {}) {
    const where = [];
    const bindings = [];
    if (status) {
      where.push('status = ?');
      bindings.push(status);
    }
    if (lane) {
      where.push('lane = ?');
      bindings.push(lane);
    }
    if (targetDesktopId) {
      // An empty target means "any desktop", the way the older records look.
      where.push("(target_desktop_id = ? OR target_desktop_id = '')");
      bindings.push(targetDesktopId);
    }

    const sql =
      'SELECT doc FROM remote_commands' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at ASC LIMIT ?';
    bindings.push(limit);

    return parseAll(await this.db.prepare(sql).bind(...bindings).all());
  }

  async claimRemoteCommand(commandId, desktopId, claimedAt) {
    const command = await this.getRemoteCommand(commandId);
    if (!command || command.status !== 'queued') return null;

    const claimed = {
      ...command,
      status: 'claimed',
      claimedByDesktopId: desktopId,
      claimedAt,
      updatedAt: claimedAt,
    };
    // The status guard in the WHERE clause is what makes this a claim rather
    // than a write: a second desktop racing for the same command changes no
    // rows and gets null back.
    const result = await this.db
      .prepare(
        "UPDATE remote_commands SET status = 'claimed', doc = ? " +
          "WHERE command_id = ? AND status = 'queued'",
      )
      .bind(JSON.stringify(claimed), commandId)
      .run();

    const changes = result.meta ? result.meta.changes : 0;
    return changes > 0 ? claimed : null;
  }

  async updateRemoteCommand(commandId, patch) {
    const command = await this.getRemoteCommand(commandId);
    if (!command) return null;
    const updated = { ...command, ...patch };
    await this.db
      .prepare('UPDATE remote_commands SET status = ?, doc = ? WHERE command_id = ?')
      .bind(updated.status || command.status, JSON.stringify(updated), commandId)
      .run();
    return updated;
  }

  async appendRemoteCommandInput(commandId, input) {
    const row = await this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM remote_command_inputs WHERE command_id = ?')
      .bind(commandId)
      .first();
    const sequence = (row && row.last ? row.last : 0) + 1;
    const entry = { ...input, sequence };
    await this.db
      .prepare('INSERT INTO remote_command_inputs (command_id, sequence, doc) VALUES (?, ?, ?)')
      .bind(commandId, sequence, JSON.stringify(entry))
      .run();
    return entry;
  }

  async listRemoteCommandInputs(commandId, afterSequence = 0) {
    return parseAll(
      await this.db
        .prepare(
          'SELECT doc FROM remote_command_inputs WHERE command_id = ? AND sequence > ? ' +
            'ORDER BY sequence ASC',
        )
        .bind(commandId, afterSequence)
        .all(),
    );
  }
}
