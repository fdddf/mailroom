// A look at a domain's public DNS, for the setup checklist in the dashboard:
// is its mail routed to Cloudflare, and is it onboarded to Email Sending?
// Read through DNS over HTTPS, so it shows what the rest of the world sees.

type Answer = { name: string; type: number; data: string }

const lookup = async (name: string, type: 'MX' | 'TXT'): Promise<string[] | null> => {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { Answer?: Answer[] }
    return (json.Answer ?? []).filter((a) => a.type === (type === 'MX' ? 15 : 16)).map((a) => a.data.replace(/^"|"$/g, '').replace(/"\s*"/g, ''))
  } catch {
    return null
  }
}

const CLOUDFLARE_MX = /\.mx\.cloudflare\.net\.?$/i
const CLOUDFLARE_SPF = /include:_spf\.mx\.cloudflare\.net/i

export type Check = { id: 'receiving' | 'spf' | 'sending' | 'dmarc'; ok: boolean | null; detail: string }

export const checkDomain = async (name: string): Promise<Check[]> => {
  const [mx, txt, bounceMx, dmarc] = await Promise.all([lookup(name, 'MX'), lookup(name, 'TXT'), lookup(`cf-bounce.${name}`, 'MX'), lookup(`_dmarc.${name}`, 'TXT')])
  const spf = txt?.filter((t) => /^v=spf1\b/i.test(t)) ?? null
  return [
    {
      id: 'receiving',
      ok: mx && mx.length > 0 && mx.every((r) => CLOUDFLARE_MX.test(r)),
      detail: mx === null ? 'DNS lookup failed' : mx.length ? mx.join(', ') : 'No MX records',
    },
    {
      id: 'spf',
      ok: spf && spf.length === 1 && CLOUDFLARE_SPF.test(spf[0]),
      detail: spf === null ? 'DNS lookup failed' : spf.length > 1 ? 'More than one SPF record' : (spf[0] ?? 'No SPF record'),
    },
    {
      id: 'sending',
      ok: bounceMx && bounceMx.some((r) => CLOUDFLARE_MX.test(r)),
      detail: bounceMx === null ? 'DNS lookup failed' : bounceMx.length ? `cf-bounce.${name}: ${bounceMx.join(', ')}` : `No records at cf-bounce.${name}`,
    },
    {
      id: 'dmarc',
      ok: dmarc && dmarc.some((t) => /^v=DMARC1/i.test(t)),
      detail: dmarc === null ? 'DNS lookup failed' : (dmarc.find((t) => /^v=DMARC1/i.test(t)) ?? 'No DMARC record'),
    },
  ].map((c) => ({ ...c, ok: c.ok === null ? null : Boolean(c.ok) })) as Check[]
}
