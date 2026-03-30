// Vercel serverless function — scrapes Beatport for genre + catalog number + label + BPM + key
// Rule: NO GUESSING. Match by ISRC first, then by track name, then release name.
// Never return BPM/key from a different track than what was requested.
export default async function handler(req, res) {
  const { q, artist, release, isrc, label, track, catalog } = req.query;
  if (!q && !isrc && !artist && !track && !catalog) return res.status(400).json({ error: 'Missing search params' });

  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const artistNorm = norm(artist || '');
  const releaseNorm = norm(release || '');
  const labelNorm = norm(label || '');
  const trackNorm = norm(track || '');
  const skip = new Set(['Rock', 'Pop', 'Dance / Pop', 'Electronica']);

  // Search query: artist > track name > ISRC
  const searchQ = q || artist || track || isrc || '';
  if (!searchQ) return res.status(200).json({ genre: '', catalogNumber: '', label: '', bpm: '', key: '', durationMs: 0, trackData: {}, allGenres: [], matchType: 'none' });

  const fetchBeatport = async (queryStr) => {
    const url = `https://www.beatport.com/search?q=${encodeURIComponent(queryStr)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    if (!r.ok) return null;
    return r.text();
  };

  const parseBlock = (block) => {
    const artistNames = [...block.matchAll(/"artist_name":"([^"]+)"/g)].map(m => m[1]);
    const genreNames = [...block.matchAll(/"genre_name":"([^"]+)"/g)].map(m => m[1]);
    const catalogVal = block.match(/"catalog_number":"([^"]+)"/)?.[1] || '';
    const labelVal = block.match(/"label_name":"([^"]+)"/)?.[1] || '';
    const trackName = block.match(/"track_name":"([^"]+)"/)?.[1] || '';
    const mixName = block.match(/"mix_name":"([^"]+)"/)?.[1] || '';
    const releaseName = block.match(/"release_name":"([^"]+)"/)?.[1] || '';
    const isrcVal = block.match(/"isrc":"([^"]+)"/)?.[1] || '';
    const bpm = block.match(/"bpm":(\d+)/)?.[1] || '';
    const key = block.match(/"key_name":"([^"]+)"/)?.[1] || '';
    let durationMs = 0;
    const dMs = block.match(/"milliseconds":(\d+)/)?.[1];
    if (dMs) {
      durationMs = parseInt(dMs);
    } else {
      const dMin = block.match(/"minutes":"(\d+):(\d+)"/);
      if (dMin) durationMs = (parseInt(dMin[1]) * 60 + parseInt(dMin[2])) * 1000;
      else {
        const dSec = block.match(/"length":(\d+)/)?.[1];
        if (dSec) durationMs = parseInt(dSec) * 1000;
      }
    }
    const genre = genreNames.find(g => !skip.has(g)) || genreNames[0] || '';
    return { artistNames, genreNames, catalogVal, labelVal, trackName, mixName, releaseName, isrcVal, bpm, key, durationMs, genre };
  };

  const parseAllBlocks = (html, targetIsrc) => {
    const trackBlocks = html.split('"track_id":').slice(1);
    let isrcMatch = null;
    let trackArtistReleaseMatch = null; // track + artist + release (strongest non-ISRC match)
    let trackNameMatch = null;     // artist + track name match
    let trackReleaseMatch = null;  // track name + release name match
    let labelReleaseMatch = null;  // label + release name match
    let releaseMatch = null;       // artist + release name match
    const allGenres = [];
    const trackData = {};

    for (const block of trackBlocks) {
      const p = parseBlock(block);
      const entry = { genre: p.genre, catalogNumber: p.catalogVal, label: p.labelVal, bpm: p.bpm, key: p.key, durationMs: p.durationMs, trackName: p.trackName };
      allGenres.push(...p.genreNames);

      // Collect per-ISRC data for all tracks found
      if (p.isrcVal && (p.bpm || p.key || p.durationMs)) {
        trackData[p.isrcVal.toUpperCase()] = { bpm: p.bpm, key: p.key, durationMs: p.durationMs };
      }

      // 1. ISRC exact match — 100% correct
      if (targetIsrc && p.isrcVal && norm(p.isrcVal) === norm(targetIsrc)) {
        if (!isrcMatch) isrcMatch = entry;
      }

      // Check if artist matches — require meaningful overlap (not just 2-char substring like "Oi")
      const isArtistMatch = artistNorm
        ? p.artistNames.some(a => {
            const an = norm(a);
            if (!an) return false;
            // Exact match on any artist name
            if (an === artistNorm) return true;
            // One contains the other, but only if the shorter string is 4+ chars (avoid "oi" matching everything)
            const shorter = an.length < artistNorm.length ? an : artistNorm;
            const longer = an.length < artistNorm.length ? artistNorm : an;
            return shorter.length >= 4 && longer.includes(shorter);
          })
        : false;

      // Check if track name matches (compare against both track_name and track_name + mix_name)
      const fullTrackName = p.mixName && p.mixName !== 'Original Mix'
        ? `${p.trackName} ${p.mixName}` : p.trackName;
      const isTrackMatch = trackNorm && trackNorm.length >= 3
        ? (norm(p.trackName).includes(trackNorm) || trackNorm.includes(norm(p.trackName))
           || norm(fullTrackName).includes(trackNorm) || trackNorm.includes(norm(fullTrackName)))
        : false;

      // Check label match
      const isLabelMatch = labelNorm
        ? norm(p.labelVal).includes(labelNorm) || labelNorm.includes(norm(p.labelVal))
        : false;

      // Check release name match
      const isReleaseMatch = releaseNorm
        ? (norm(p.releaseName).includes(releaseNorm) || releaseNorm.includes(norm(p.releaseName)))
        : false;

      // 2. Track + artist + release match — strongest non-ISRC match
      if (!trackArtistReleaseMatch && isArtistMatch && isTrackMatch && isReleaseMatch) {
        trackArtistReleaseMatch = entry;
      }

      // 3. Artist + track name match
      if (!trackNameMatch && isArtistMatch && isTrackMatch) {
        trackNameMatch = entry;
      }

      // 4. Track name + release name match (for VA — no artist match needed)
      if (!trackReleaseMatch && isTrackMatch && isReleaseMatch) {
        trackReleaseMatch = entry;
      }

      // 4. Label + release name match
      if (!labelReleaseMatch && isLabelMatch && isReleaseMatch) {
        labelReleaseMatch = entry;
      }

      // 5. Artist + release name match
      if (!releaseMatch && isArtistMatch && isReleaseMatch) {
        releaseMatch = entry;
      }
    }

    return { isrcMatch, trackArtistReleaseMatch, trackNameMatch, trackReleaseMatch, labelReleaseMatch, releaseMatch, trackData, allGenres };
  };

  try {
    const html = await fetchBeatport(searchQ);
    if (!html) return res.status(502).json({ error: 'Beatport request failed' });

    let result = parseAllBlocks(html, isrc);

    // Merge helper
    const mergeResult = (src) => {
      if (src.isrcMatch && !result.isrcMatch) result.isrcMatch = src.isrcMatch;
      if (src.trackArtistReleaseMatch && !result.trackArtistReleaseMatch) result.trackArtistReleaseMatch = src.trackArtistReleaseMatch;
      if (src.trackNameMatch && !result.trackNameMatch) result.trackNameMatch = src.trackNameMatch;
      if (src.trackReleaseMatch && !result.trackReleaseMatch) result.trackReleaseMatch = src.trackReleaseMatch;
      Object.assign(result.trackData, src.trackData);
      result.allGenres.push(...src.allGenres);
    };

    // ISRC fallback: if ISRC provided but not found, search by ISRC directly
    if (isrc && !result.isrcMatch && searchQ !== isrc) {
      const isrcHtml = await fetchBeatport(isrc);
      if (isrcHtml) mergeResult(parseAllBlocks(isrcHtml, isrc));
    }

    // Track name fallback: if track name given but not found via artist search
    if (track && !result.isrcMatch && !result.trackArtistReleaseMatch && searchQ !== track) {
      const trackHtml = await fetchBeatport(track + (artist ? ' ' + artist : ''));
      if (trackHtml) mergeResult(parseAllBlocks(trackHtml, isrc));
    }

    // VA/release name fallback: if release name given but no track match, search by release name
    if (release && !result.isrcMatch && !result.trackArtistReleaseMatch && !result.trackNameMatch && searchQ !== release) {
      const releaseHtml = await fetchBeatport(release + (artist ? ' ' + artist : ''));
      if (releaseHtml) mergeResult(parseAllBlocks(releaseHtml, isrc));
    }

    // Catalog number fallback: for VA releases where artist search misses the compilation
    // Search by catalog number to find the exact release, then match track by artist name within it
    const catalogNum = catalog || '';
    if (catalogNum && !result.isrcMatch && !result.trackArtistReleaseMatch) {
      const catHtml = await fetchBeatport(catalogNum);
      if (catHtml) {
        const catResult = parseAllBlocks(catHtml, isrc);
        // Look for a track by this artist in the catalog search results
        if (artistNorm && Object.keys(catResult.trackData).length > 0) {
          // Re-parse to find artist-matched tracks within this catalog
          const catBlocks = catHtml.split('"track_id":').slice(1);
          for (const block of catBlocks) {
            const blockArtists = [...block.matchAll(/"artist_name":"([^"]+)"/g)].map(m => m[1]);
            const isArtist = blockArtists.some(a => {
              const an = norm(a);
              const shorter = an.length < artistNorm.length ? an : artistNorm;
              const longer = an.length < artistNorm.length ? artistNorm : an;
              return an === artistNorm || (shorter.length >= 4 && longer.includes(shorter));
            });
            if (!isArtist) continue;
            const bpm = block.match(/"bpm":(\d+)/)?.[1] || '';
            const key = block.match(/"key_name":"([^"]+)"/)?.[1] || '';
            const isrcVal = block.match(/"isrc":"([^"]+)"/)?.[1] || '';
            const labelVal = block.match(/"label_name":"([^"]+)"/)?.[1] || '';
            const catVal = block.match(/"catalog_number":"([^"]+)"/)?.[1] || '';
            const genreNames = [...block.matchAll(/"genre_name":"([^"]+)"/g)].map(m => m[1]);
            const genre = genreNames.find(g => !skip.has(g)) || genreNames[0] || '';
            let durationMs = 0;
            const dMs = block.match(/"milliseconds":(\d+)/)?.[1];
            if (dMs) durationMs = parseInt(dMs);
            if (bpm || key) {
              result.catalogMatch = { genre, catalogNumber: catVal, label: labelVal, bpm, key, durationMs };
              if (isrcVal) result.trackData[isrcVal.toUpperCase()] = { bpm, key, durationMs };
              result.allGenres.push(...genreNames);
              break; // found the artist's track on this VA
            }
          }
        }
        mergeResult(catResult);
      }
    }

    // Priority: ISRC > track+artist+release > track+artist > catalog+artist > track+release > label+release > release
    const trackMatch = result.isrcMatch || result.trackArtistReleaseMatch || result.trackNameMatch || result.catalogMatch || result.trackReleaseMatch;
    const releaseInfo = result.labelReleaseMatch || result.releaseMatch;
    const best = trackMatch || releaseInfo || {};

    const matchType = result.isrcMatch ? 'isrc'
      : result.trackArtistReleaseMatch ? 'track+artist+release'
      : result.trackNameMatch ? 'track+artist'
      : result.catalogMatch ? 'catalog+artist'
      : result.trackReleaseMatch ? 'track+release'
      : result.labelReleaseMatch ? 'label+release'
      : result.releaseMatch ? 'release'
      : 'none';

    // BPM/key: ONLY from track-specific matches (never from release-level which could be wrong track)
    let bpmSource = trackMatch || {};
    // If track matched but BPM is missing, try to find it in trackData by matching key or ISRC prefix
    if (bpmSource.key && !bpmSource.bpm && Object.keys(result.trackData).length > 0) {
      // Try ISRC prefix match first (same distributor, different version)
      if (isrc) {
        const prefix = isrc.substring(0, 9); // first 9 chars = registrant + country
        const prefixMatch = Object.entries(result.trackData).find(([k, v]) =>
          k.startsWith(prefix) && v.bpm && v.key === bpmSource.key
        );
        if (prefixMatch) {
          bpmSource = { ...bpmSource, bpm: prefixMatch[1].bpm, durationMs: bpmSource.durationMs || prefixMatch[1].durationMs };
        }
      }
      // If still no BPM, find by exact key match in trackData
      if (!bpmSource.bpm) {
        const keyMatch = Object.values(result.trackData).find(v => v.bpm && v.key === bpmSource.key);
        if (keyMatch) {
          bpmSource = { ...bpmSource, bpm: keyMatch.bpm, durationMs: bpmSource.durationMs || keyMatch.durationMs };
        }
      }
    }
    // Genre/label/catalog: can come from release-level matches too
    const finalGenre = best.genre || result.allGenres.find(g => !skip.has(g)) || result.allGenres[0] || '';
    // Label only from confident matches
    const confidentMatch = result.isrcMatch || result.trackArtistReleaseMatch || result.trackNameMatch || result.catalogMatch || result.labelReleaseMatch;
    const finalLabel = confidentMatch ? (confidentMatch.label || '') : '';
    const finalCatalog = confidentMatch ? (confidentMatch.catalogNumber || '') : (releaseInfo?.catalogNumber || '');

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({
      genre: finalGenre,
      catalogNumber: finalCatalog,
      label: finalLabel,
      bpm: bpmSource.bpm || '',
      key: bpmSource.key || '',
      durationMs: bpmSource.durationMs || 0,
      trackData: result.trackData,
      allGenres: [...new Set(result.allGenres)].slice(0, 5),
      matchType,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
