import { useState, useRef } from 'react';

const T = { bg: "#0B0B0F", surface: "#14141B", surfaceAlt: "#1A1A24", border: "#2A2A38", accent: "#E8C547", accentDim: "#B89A30", accentGlow: "rgba(232,197,71,0.12)", danger: "#E85454", success: "#4ADE80", text: "#E8E8EC", textMid: "#9898A8", textDim: "#5E5E72", white: "#FFFFFF" };
const font = `'DM Sans', 'Segoe UI', sans-serif`;
const fontMono = `'DM Mono', 'Fira Code', monospace`;
const inputStyle = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontFamily: font, fontSize: 13, padding: '10px 14px', outline: 'none', transition: 'border-color 0.15s' };

const SPOTIFY_CLIENT_ID = "bca77dbc2b9c46b2aac649615b312e49";
const SPOTIFY_CLIENT_SECRET = "3141f52d6af345b18f24fd1a6539d33c";
let _token = null, _tokenExp = 0;

async function getSpotifyToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET) },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  _token = data.access_token;
  _tokenExp = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

const fmtDuration = (ms) => { if (!ms) return ''; let val = ms; if (val > 10000000) val = Math.round(val / 1000); const s = Math.round(val / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('');

  // Artist search + lock
  const [artistSugg, setArtistSugg] = useState([]);
  const [showArtistSugg, setShowArtistSugg] = useState(false);
  const [lockedArtist, setLockedArtist] = useState(null); // { id, name, image }
  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  const fetchArtistSugg = async (q) => {
    if (!q || q.length < 2) { setArtistSugg([]); setShowArtistSugg(false); return; }
    try {
      const token = await getSpotifyToken();
      if (!token) return;
      const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=artist&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = await res.json();
      const items = (d.artists?.items || []).map(a => ({
        id: a.id, name: a.name,
        image: a.images?.[1]?.url || a.images?.[0]?.url || '',
        genres: (a.genres || []).slice(0, 2),
      }));
      setArtistSugg(items);
      if (items.length > 0) setShowArtistSugg(true);
    } catch {}
  };

  const pickArtist = (artist) => {
    setShowArtistSugg(false);
    setArtistSugg([]);
    setQuery('');
    setLockedArtist(artist);
  };

  const clearArtist = () => {
    setLockedArtist(null);
    setResults([]);
    setStatus('');
    setQuery('');
  };

  const analyze = async () => {
    let artist = lockedArtist;
    // If not locked, search and auto-lock top result
    if (!artist) {
      if (!query.trim()) return;
      setLoading(true);
      setStatus('Searching for artist...');
      const token = await getSpotifyToken();
      if (!token) { setLoading(false); setStatus('Could not get Spotify token.'); return; }
      const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query.trim())}&type=artist&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { setLoading(false); setStatus('Artist search failed.'); return; }
      const d = await res.json();
      const items = (d.artists?.items || []).map(a => ({ id: a.id, name: a.name, image: a.images?.[1]?.url || a.images?.[0]?.url || '' }));
      if (!items.length) { setLoading(false); setStatus(`No artist found for "${query.trim()}".`); return; }
      artist = items[0];
      setLockedArtist(artist);
      setQuery('');
    } else {
      setLoading(true);
    }

    setResults([]);
    const artistName = artist.name;

    // ── STEP 1: Discovery — Spotify /artists/{id}/albums ──────────────────
    setStatus(`Fetching ${artistName}'s discography...`);
    const token = await getSpotifyToken();
    if (!token) { setLoading(false); setStatus('Could not get Spotify token.'); return; }

    const albumShells = [];
    let url = `https://api.spotify.com/v1/artists/${artist.id}/albums?include_groups=album,single,compilation,appears_on`;
    let page = 0;
    while (url) {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) break;
        const data = await res.json();
        page++;
        setStatus(`Page ${page}… (${albumShells.length + (data.items?.length || 0)} releases)`);
        for (const a of (data.items || [])) {
          albumShells.push({
            id: a.id, name: a.name,
            albumGroup: a.album_group, albumType: a.album_type,
            artists: (a.artists || []).map(ar => ar.name).join(', '),
            releaseDate: a.release_date || '',
            artworkUrl: a.images?.[0]?.url || '',
          });
        }
        url = data.next || null;
      } catch { break; }
    }

    if (!albumShells.length) { setLoading(false); setStatus('No releases found on Spotify.'); return; }
    setStatus(`Found ${albumShells.length} releases — fetching tracks & enriching...`);

    // ── STEP 2 + 3: Per-album track fetch + Beatport enrichment ───────────
    const albumResults = [];
    for (let ai = 0; ai < albumShells.length; ai++) {
      const shell = albumShells[ai];
      setStatus(`Enriching ${ai + 1}/${albumShells.length}: ${shell.name}`);

      // Fetch full album + tracks with ISRCs
      let tracks = [];
      try {
        const albumRes = await fetch(`https://api.spotify.com/v1/albums/${shell.id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (albumRes.ok) {
          const albumData = await albumRes.json();
          if (albumData.tracks?.items?.length) {
            const ids = albumData.tracks.items.map(t => t.id).filter(Boolean);
            for (let i = 0; i < ids.length; i += 50) {
              const batch = ids.slice(i, i + 50);
              const tRes = await fetch(`https://api.spotify.com/v1/tracks?ids=${batch.join(',')}`, { headers: { Authorization: `Bearer ${token}` } });
              if (tRes.ok) {
                const tData = await tRes.json();
                tracks.push(...(tData.tracks || []).filter(Boolean).map(t => ({
                  name: t.name || '', isrc: t.external_ids?.isrc || '',
                  duration: t.duration_ms || 0, bpm: '', key: '',
                  artists: (t.artists || []).map(a => a.name).join(', '),
                })));
              }
            }
          }
        }
      } catch {}

      // Beatport enrichment — full context
      let label = '', catalog = '', genre = '';
      const firstIsrc = tracks.find(t => t.isrc)?.isrc || '';
      const firstTrackName = tracks[0]?.name || '';
      try {
        const bpRes = await fetch(`/api/beatport-genre?artist=${encodeURIComponent(shell.artists)}&q=${encodeURIComponent(shell.name)}&isrc=${firstIsrc}&track=${encodeURIComponent(firstTrackName)}`);
        if (bpRes.ok) {
          const bp = await bpRes.json();
          const goodMatch = ['isrc', 'release', 'track+artist+release', 'track+artist', 'catalog+artist', 'track+release'].includes(bp.matchType);
          if (goodMatch) {
            genre = bp.genre || '';
            label = bp.label || '';
            catalog = bp.catalogNumber || '';
            // Per-track BPM/key from trackData
            for (const t of tracks) {
              const td = t.isrc ? (bp.trackData?.[t.isrc.toUpperCase()] || {}) : {};
              const isSingle = tracks.length === 1;
              t.bpm = td.bpm || (isSingle ? bp.bpm : '') || '';
              t.key = td.key || (isSingle ? bp.key : '') || '';
            }
          }
        }
      } catch {}

      albumResults.push({
        albumName: shell.name,
        albumType: shell.albumGroup || shell.albumType || '',
        artwork: shell.artworkUrl,
        artists: shell.artists,
        releaseDate: shell.releaseDate,
        label, catalog, genre,
        tracks,
      });

      // Progressive render
      setResults([...albumResults]);
      await new Promise(r => setTimeout(r, 80));
    }

    const totalTracks = albumResults.reduce((s, a) => s + a.tracks.length, 0);
    setStatus(`Done — ${albumResults.length} releases · ${totalTracks} tracks`);
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: font, padding: '40px 20px' }}>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}@keyframes spin{to{transform:rotate(360deg)}}@keyframes slideDown{from{opacity:0;transform:translateY(-8px) scaleY(0.92)}to{opacity:1;transform:translateY(0) scaleY(1)}}`}</style>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: `linear-gradient(135deg, ${T.accent}, ${T.accentDim})`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke={T.bg} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>ANALYZING DATA</h1>
          <p style={{ color: T.textMid, fontSize: 14, marginTop: 8 }}>Spotify discovery + Beatport enrichment engine</p>
        </div>

        {/* Search Bar */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            {lockedArtist ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12 }}>
                {lockedArtist.image
                  ? <img src={lockedArtist.image} style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 32, height: 32, borderRadius: '50%', background: T.accentGlow, flexShrink: 0 }} />
                }
                <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{lockedArtist.name}</span>
                <button onClick={clearArtist} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textDim, fontSize: 14, padding: '2px 6px' }}>× Clear</button>
              </div>
            ) : (
              <>
                <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={T.textDim} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  ref={inputRef}
                  value={query} onChange={e => {
                    setQuery(e.target.value);
                    clearTimeout(debounceRef.current);
                    debounceRef.current = setTimeout(() => fetchArtistSugg(e.target.value), 280);
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') { setShowArtistSugg(false); analyze(); } if (e.key === 'Escape') setShowArtistSugg(false); }}
                  onBlur={() => setTimeout(() => setShowArtistSugg(false), 300)}
                  onFocus={() => { if (artistSugg.length > 0) setShowArtistSugg(true); }}
                  placeholder="Search artist name..."
                  style={{ width: '100%', padding: '14px 14px 14px 42px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, color: T.text, fontFamily: font, fontSize: 15, outline: 'none', transition: 'border-color 0.15s' }}
                  autoFocus
                />
                {/* Artist suggestions dropdown */}
                {showArtistSugg && artistSugg.length > 0 && (() => {
                  const rect = inputRef.current?.getBoundingClientRect();
                  if (!rect) return null;
                  return (
                    <div style={{ position: 'fixed', zIndex: 99, left: rect.left, top: rect.bottom + 4, width: rect.width, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', maxHeight: 300, overflowY: 'auto', animation: 'slideDown 0.18s cubic-bezier(0.4,0,0.2,1)' }}>
                      {artistSugg.map(a => (
                        <div key={a.id} onMouseDown={() => pickArtist(a)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${T.border}`, transition: 'background 0.15s' }} onMouseEnter={e => e.currentTarget.style.background = T.border} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          {a.image ? <img src={a.image} style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} /> : <div style={{ width: 32, height: 32, borderRadius: '50%', background: T.surface }} />}
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{a.name}</div>
                            {a.genres.length > 0 && <div style={{ fontSize: 11, color: T.textDim, marginTop: 1 }}>{a.genres.join(', ')}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
          <button onClick={analyze} disabled={loading}
            style={{ padding: '14px 28px', background: `linear-gradient(135deg, ${T.accent}, ${T.accentDim})`, border: 'none', borderRadius: 12, color: T.bg, fontFamily: font, fontSize: 14, fontWeight: 700, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1, transition: 'all 0.15s' }}>
            {loading ? <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={T.bg} strokeWidth={2.5} style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> : 'Analyze'}
          </button>
        </div>

        {/* Status */}
        {status && <div style={{ fontSize: 12, color: loading ? T.accent : T.textMid, marginBottom: 20, textAlign: 'center' }}>{status}</div>}

        {/* Results */}
        {results.map((album, ai) => (
          <div key={ai} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, marginBottom: 12, overflow: 'hidden' }}>
            {/* Album Header */}
            <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
              {album.artwork ? <img src={album.artwork} style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover' }} /> : <div style={{ width: 48, height: 48, borderRadius: 10, background: T.accentGlow, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth={2}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{album.albumName || 'Unknown'}</div>
                <div style={{ fontSize: 12, color: T.textMid, marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {album.artists}
                  {album.albumType && <span style={{ color: T.white, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', textTransform: 'uppercase' }}>{album.albumType === 'compilation' ? 'VA' : album.albumType}</span>}
                  {album.genre && <span style={{ color: T.danger, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(232,84,84,0.15)' }}>{album.genre}</span>}
                  {album.catalog && <span style={{ color: T.white, fontSize: 10, fontFamily: fontMono, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.08)' }}>{album.catalog}</span>}
                  {album.label && <span style={{ color: T.accent, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: T.accentGlow }}>{album.label}</span>}
                </div>
              </div>
              <div style={{ fontSize: 11, color: T.textDim, textAlign: 'right' }}>
                <div>{album.tracks.length} track{album.tracks.length !== 1 ? 's' : ''}</div>
                {album.releaseDate && <div style={{ marginTop: 2 }}>{album.releaseDate}</div>}
              </div>
            </div>
            {/* Tracks */}
            <div style={{ borderTop: `1px solid ${T.border}`, padding: '8px 20px' }}>
              {album.tracks.map((t, ti) => (
                <div key={ti} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: ti < album.tracks.length - 1 ? `1px solid ${T.border}` : 'none', fontSize: 13 }}>
                  <span style={{ fontFamily: fontMono, fontSize: 11, color: T.textDim, width: 24 }}>{String(ti + 1).padStart(2, '0')}</span>
                  <span style={{ flex: 1 }}>{t.name || 'Unknown'}</span>
                  {t.duration > 0 && <span style={{ fontSize: 10, color: T.textDim, fontFamily: fontMono }}>{fmtDuration(t.duration)}</span>}
                  {t.bpm && <span style={{ color: '#4FC3F7', fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(79,195,247,0.08)' }}>{t.bpm} BPM</span>}
                  {t.key && <span style={{ color: '#4FC3F7', fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(79,195,247,0.08)' }}>{t.key}</span>}
                  <span style={{ fontFamily: fontMono, fontSize: 10, color: T.textDim }}>{t.isrc}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Footer */}
        <div style={{ textAlign: 'center', padding: '24px 0', marginTop: 20 }}>
          <span style={{ fontSize: 11, color: T.textDim }}>ANALYZING DATA</span>
          <span style={{ fontSize: 11, color: T.textDim, margin: '0 8px' }}>·</span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', padding: '2px 8px', borderRadius: 20, background: T.accentGlow, color: T.accent }}>BETA</span>
        </div>
      </div>
    </div>
  );
}
