import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { readFileSync, openSync, closeSync, readSync, statSync } from 'node:fs'
import { verify } from 'node:crypto'
import { DatabaseService } from './database.service'

export function downloadEvent(row: Record<string, any>, packages: Array<{ version: string; platform: string; file: string }>): { requestId: string; version: string; platform: string; source: string; ip: string; at: number } | null {
  const item = packages.find(pkg => String(row.uri || '').split('?')[0].endsWith('/' + pkg.file))
  if (!item || row.method !== 'GET' || !['200', '206'].includes(String(row.status)) || Number(row.bytes) <= 0 || row.verify === '1' || /KH-Link-release-verifier/i.test(row.agent || '')) return null
  if (row.range && !/^bytes=0-\d*$/.test(row.range)) return null
  if (String(row.status) === '206' && !/^bytes 0-/.test(row.contentRange || '')) return null
  const at = Date.parse(row.at)
  if (!Number.isFinite(at) || !/^[a-zA-Z0-9_-]{8,96}$/.test(row.id || '')) return null
  const source = ['website', 'member', 'admin'].includes(row.source) ? row.source : String(row.referer || '').startsWith('https://khsci.com/khlink/') ? 'website' : row.referer ? 'portal' : 'direct'
  return { requestId: row.id, version: item.version, platform: item.platform, source, ip: String(row.ip || '').slice(0, 48), at }
}

@Injectable()
export class DownloadMetricsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout
  private inode = 0
  private position = 0
  private pending = ''
  private retainedAt = 0
  constructor(private readonly database: DatabaseService) {}
  onModuleInit(): void {
    const file = process.env.KH_LINK_DOWNLOAD_LOG
    if (!file) return
    try { const stat = statSync(file); const saved = this.database.downloadCursor(file); this.inode = saved?.inode || stat.ino; this.position = saved?.position ?? stat.size; this.pending = saved?.pending || ''; } catch { /* Starts from deployment time, not old traffic. */ }
    this.timer = setInterval(() => this.collect(), 10_000); this.timer.unref()
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer) }
  collect(): void {
    const file = process.env.KH_LINK_DOWNLOAD_LOG
    const directory = process.env.KH_LINK_DOWNLOAD_DIR || '/var/www/fengzhu-agent-bridge'
    if (!file) return
    try {
      if (Date.now() - this.retainedAt >= 6 * 3600_000) { this.database.pruneDownloadDetails(); this.retainedAt = Date.now() }
      const stat = statSync(file)
      if (stat.ino !== this.inode || stat.size < this.position) { this.inode = stat.ino; this.position = 0; this.pending = '' }
      if (stat.size === this.position) return
      const manifestBytes = readFileSync(`${directory}/update-manifest.json`)
      if (!verify(null, manifestBytes, readFileSync(`${directory}/update-signing-public.pem`), readFileSync(`${directory}/update-manifest.sig`))) return
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const packages = [['android', 'android'], ['windowsConnector', 'connector'], ['windowsDesktop', 'desktop']].flatMap(([key, platform]) => {
        const item = manifest[key]
        if (!item?.url) return []
        const fileName = new URL(item.url).pathname.split('/').pop()!
        try { if (!statSync(`${directory}/${fileName}`).isFile()) return [] } catch { return [] }
        return [{ version: item.versionName || item.version, platform, file: fileName }]
      })
      const fd = openSync(file, 'r')
      const bytes = Buffer.alloc(Math.min(stat.size - this.position, 1024 * 1024))
      try { const count = readSync(fd, bytes, 0, bytes.length, this.position); this.position += count; this.pending += bytes.subarray(0, count).toString('utf8') } finally { closeSync(fd) }
      const lines = this.pending.split('\n'); this.pending = lines.pop() || ''
      if (this.pending.length > 65536) this.pending = ''
      for (const line of lines) try { const event = downloadEvent(JSON.parse(line), packages); if (event) this.database.recordAdminDownload(event) } catch { /* Invalid or unrelated log line. */ }
      this.database.saveDownloadCursor(file, { inode: this.inode, position: this.position, pending: this.pending })
    } catch { /* Missing log or unpublished files must not break the relay. */ }
  }
}
