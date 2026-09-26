/**
 * PDF/psych-sheet/athlete-history parsing routes. The Python subprocess
 * pipelines behind them live in the sibling `parsingPipeline.ts`, split out
 * purely to keep this function under the repo's line-count ceiling.
 *
 * Extracted from `server.ts`'s `startServer` (H2, code-health refactor,
 * 2026-09-25) with no behavior change: same paths, methods, subprocess
 * invocation order and fallbacks, and error handling as before.
 */
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { Gender, SwimmerResult } from '../../../../packages/core/src/types.ts';
import { parseSwimCloudPasteDetailed } from '../../../../packages/core/src/lib/athleteHistory.ts';
import {
  parsePdfSchema,
  parsePsychPdfSchema,
  parseAthleteHistorySchema,
} from '../../../../packages/core/src/schemas/workspace.ts';
import { runPythonScript, mapPsychRows, parsePsychPdfFile, parseMeetUnified, parseMeetLegacy } from './parsingPipeline.ts';

export interface ParsingRoutesDeps {
  projectRoot: string;
  dataDir: string;
  pdfParserScript: string;
  parseMeetScript: string;
  parsePsychScript: string;
  pointCalculatorScript: string;
  teamRankingsScript: string;
  aiEnabled: boolean;
}

export function registerParsingRoutes(app: Express, deps: ParsingRoutesDeps): void {
  const {
    projectRoot: PROJECT_ROOT,
    parsePsychScript: PARSE_PSYCH_SCRIPT,
    aiEnabled: AI_ENABLED,
  } = deps;

  app.post('/api/parse-pdf', async (req, res) => {
    const parsed = parsePdfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid PDF payload', details: parsed.error.issues });
    }
    const { base64, format } = parsed.data;
    const tempFile = path.join(PROJECT_ROOT, `temp_${Date.now()}.pdf`);
    try {
      fs.writeFileSync(tempFile, Buffer.from(base64, 'base64'));
      const fmt = format || 'auto';
      let payload;
      try {
        payload = await parseMeetUnified(deps, tempFile, fmt);
      } catch (unifiedErr) {
        console.warn('Unified parse_meet failed, falling back to legacy pipeline:', unifiedErr);
        payload = await parseMeetLegacy(deps, tempFile, fmt);
      }
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: 'Failed to parse PDF', details: String(error) });
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  app.post('/api/parse-psych-pdf', async (req, res) => {
    const parsed = parsePsychPdfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid psych PDF payload', details: parsed.error.issues });
    }
    const { base64, format } = parsed.data;
    if (!base64?.trim()) {
      return res.status(400).json({ error: 'No PDF data in request' });
    }
    const tempFile = path.join(PROJECT_ROOT, `temp_psych_${Date.now()}.pdf`);
    try {
      fs.writeFileSync(tempFile, Buffer.from(base64, 'base64'));
      const fmt = format || 'auto';
      let results: SwimmerResult[];
      try {
        results = await parsePsychPdfFile(deps, tempFile, fmt);
      } catch (primaryErr) {
        console.warn('Psych parse via pdf_parser failed, trying psych_parser.py:', primaryErr);
        const output = await runPythonScript(deps, PARSE_PSYCH_SCRIPT, [tempFile, fmt]);
        const trimmed = output.trim();
        if (!trimmed) {
          throw new Error('Psych parser returned empty output');
        }
        const parsedJson = JSON.parse(trimmed) as { error?: string; results?: Record<string, unknown>[] };
        if (parsedJson.error) {
          return res.status(500).json({ error: parsedJson.error });
        }
        const rawRows = Array.isArray(parsedJson.results) ? parsedJson.results : [];
        results = mapPsychRows(rawRows);
      }
      if (results.length === 0) {
        return res.status(422).json({
          error: 'No individual psych entries found',
          details: 'Try Regular List or Divided (2-Col) format from the dropdown.',
        });
      }
      return res.json({ results });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to parse psych PDF', details: String(error) });
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  app.post('/api/parse-athlete-history', async (req, res) => {
    const validated = parseAthleteHistorySchema.safeParse(req.body ?? {});
    if (!validated.success) {
      return res.status(400).json({ error: 'Invalid request', details: validated.error.issues });
    }
    try {
      const { text, imageBase64, team, gender, swimmerName, division } = validated.data;
      const g = gender === Gender.WOMEN || gender === 'Women' ? Gender.WOMEN : Gender.MEN;
      const teamName = typeof team === 'string' && team.trim() ? team.trim() : 'Unknown';
      const div = division === 'D2' || division === 'D3' || division === 'NAIA' ? division : 'D1';
      if (typeof text === 'string' && text.trim()) {
        const result = parseSwimCloudPasteDetailed(text, {
          team: teamName,
          gender: g,
          swimmerName: typeof swimmerName === 'string' ? swimmerName : undefined,
          division: div,
        });
        return res.json(result);
      }
      if (typeof imageBase64 === 'string' && imageBase64.trim() && AI_ENABLED && process.env.GEMINI_API_KEY) {

        let GoogleGenAI: any;
        try {
          // @ts-expect-error — @google/genai is an optional runtime dep; omitted from package.json intentionally
          ({ GoogleGenAI } = await import('@google/genai'));
        } catch {
          return res.status(501).json({ error: 'AI image parsing is not installed in this build' });
        }
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'Extract swimmer rows as JSON array: [{name, event, time}]. No markdown.' },
                { inlineData: { mimeType: 'image/png', data: imageBase64 } },
              ],
            },
          ],
        });
        const raw = response.text ?? '[]';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');
        const swims = (Array.isArray(parsed) ? parsed : []).map((row: Record<string, string>) => ({
          name: String(row.name ?? ''),
          team: teamName,
          gender: g,
          event: String(row.event ?? ''),
          time: String(row.time ?? ''),
          source: 'ocr' as const,
        }));
        return res.json({ swims: swims.filter((s: { name: string; event: string }) => s.name && s.event) });
      }
      return res.status(400).json({
        error: AI_ENABLED
          ? 'Provide pasted text, or imageBase64 with GEMINI_API_KEY'
          : 'Image parsing is disabled. Provide pasted text or set OMNI_AI_ENABLED=true with GEMINI_API_KEY.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'Parse failed', details: String(err) });
    }
  });

  // No upload middleware is mounted: the handler returns 501 and does nothing
  // with a file, but multer writes to disk BEFORE the handler runs, so mounting
  // it accepted an unauthenticated write from anyone who could reach the port.
  // Re-enable via createVideoUpload() when the feature is actually implemented.
  app.post('/api/analyze-video', async (_req, res) => {
    res.status(501).json({
      error: 'Gemini video analysis reserved for a future release. Use local metrics in the Metrics applet.',
    });
  });
}
