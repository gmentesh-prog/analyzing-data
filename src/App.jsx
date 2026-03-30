import { useState } from 'react';

const T = { bg: "#0B0B0F", surface: "#14141B", surfaceAlt: "#1A1A24", border: "#2A2A38", accent: "#E8C547", accentDim: "#B89A30", accentGlow: "rgba(232,197,71,0.12)", danger: "#E85454", success: "#4ADE80", text: "#E8E8EC", textMid: "#9898A8", textDim: "#5E5E72", white: "#FFFFFF" };
const font = `'DM Sans', 'Segoe UI', sans-serif`;
const fontMono = `'DM Mono', 'Fira Code', monospace`;

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

async function analyzingData(artistName) {
  const results = [];

  // Step 1: Beatport — get ALL ISRCs for this artist
  const bpRes = await fetch(`/api/beatport-genre?q=${encodeURIComponent(artistName)}&artist=${encodeURIComponent(artistName)}`);
  const bp = await bpRes.json();
  const beatportIsrcs = Object.entries(bp.trackData || {});

  // Step 2: Each ISRC → Spotify (track name, album, artwork) + Beatport ISRC match (label, catalog, BPM, key)
  const token = await getSpotifyToken();
  const albumMap = {};

  for (const [isrc, bpTrack] of beatportIsrcs) {
    // Spotify: get track + album info
    let spotTrack = null;
    try {
      const res = await fetch(`https://api.spotify.com/v1/search?q=isrc:${isrc}&type=track&limit=3`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      spotTrack = (data.tracks?.items || [])[0];
    } catch {}

    // Beatport: individual ISRC lookup for label/catalog
    let bpIsrc = { label: '', catalogNumber: '', genre: '', bpm: bpTrack.bpm, key: bpTrack.key, durationMs: bpTrack.durationMs };
    try {
      const bpRes2 = await fetch(`/api/beatport-genre?q=${isrc}&isrc=${isrc}`);
      const bpData = await bpRes2.json();
      if (bpData.matchType === 'isrc') bpIsrc = { ...bpIsrc, label: bpData.label, catalogNumber: bpData.catalogNumber, genre: bpData.genre, bpm: bpData.bpm || bpTrack.bpm, key: bpData.key || bpTrack.key };
    } catch {}

    const trackName = spotTrack?.name || '';
    const albumName = spotTrack?.album?.name || '';
    const albumType = spotTrack?.album?.album_type || '';
    const albumId = spotTrack?.album?.id || isrc;
    const artwork = spotTrack?.album?.images?.[0]?.url || '';
    const artists = spotTrack ? (spotTrack.artists || []).map(a => a.name).join(', ') : artistName;
    const duration = spotTrack?.duration_ms || bpTrack.durationMs || 0;

    if (!albumMap[albumId]) {
      albumMap[albumId] = {
        albumName, albumType, artwork, artists,
        releaseDate: spotTrack?.album?.release_date || '',
        label: bpIsrc.label, catalog: bpIsrc.catalogNumber, genre: bpIsrc.genre,
        tracks: [],
      };
    }
    albumMap[albumId].tracks.push({ name: trackName, isrc, bpm: bpIsrc.bpm, key: bpIsrc.key, duration, artists });
    // Fill album-level data from first ISRC match
    if (!albumMap[albumId].label && bpIsrc.label) albumMap[albumId].label = bpIsrc.label;
    if (!albumMap[albumId].catalog && bpIsrc.catalogNumber) albumMap[albumId].catalog = bpIsrc.catalogNumber;
    if (!albumMap[albumId].genre && bpIsrc.genre) albumMap[albumId].genre = bpIsrc.genre;

    await new Promise(r => setTimeout(r, 150));
  }

  return Object.values(albumMap);
}

const fmtDuration = (ms) => { if (!ms) return ''; let val = ms; if (val > 10000000) val = Math.round(val / 1000); const s = Math.round(val / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function App() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('');

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResults([]);
    setStatus('Searching Beatport for ISRCs...');
    try {
      const albums = await analyzingData(query.trim());
      setResults(albums);
      const totalTracks = albums.reduce((s, a) => s + a.tracks.length, 0);
      setStatus(`Found ${albums.length} releases · ${totalTracks} tracks`);
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: font, padding: '40px 20px' }}>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: `linear-gradient(135deg, ${T.accent}, ${T.accentDim})`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke={T.bg} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>ANALYZING DATA</h1>
          <p style={{ color: T.textMid, fontSize: 14, marginTop: 8 }}>ISRC-first music metadata engine</p>
        </div>

        {/* Search Bar */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={T.textDim} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="Enter artist name..."
              style={{ width: '100%', padding: '14px 14px 14px 42px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, color: T.text, fontFamily: font, fontSize: 15, outline: 'none', transition: 'border-color 0.15s' }}
              onFocus={e => e.target.style.borderColor = T.accent}
              onBlur={e => e.target.style.borderColor = T.border}
            />
          </div>
          <button onClick={search} disabled={loading}
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
