import assert from 'node:assert/strict';
import { parseBwbXml } from './bwb-parser.js';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<toestand bwb-id="BWBRTEST" inwerkingtreding="2026-07-01">
  <wetgeving bwb-id="BWBRTEST">
    <intitule>Testwet</intitule>
    <wet-besluit>
      <wettekst>
        <boek>
          <kop><label>Boek</label><nr>7</nr></kop>
          <titeldeel>
            <kop><label>Titel</label><nr>10</nr></kop>
            <afdeling>
              <kop><label>Afdeling</label><nr>1</nr></kop>
              <artikel>
                <kop><label>Artikel</label><nr>628</nr></kop>
                <lid>
                  <lidnr>1</lidnr>
                  <al>In geval van elkaar opvolgende arbeidsovereenkomsten als bedoeld in <intref>artikel 668a</intref> kan een afwijking worden overeengekomen.</al>
                </lid>
                <lid>
                  <lidnr>2</lidnr>
                  <al>Het minimumloon bedraagt:</al>
                  <lijst>
                    <li><li.nr>a.</li.nr><al>voor de toepassing van deze wet: per uur € 10,60<redactie type="extra">per 1 januari 2026: € 14,71</redactie> ;</al></li>
                    <li><li.nr>b.</li.nr><al>een tweede onderdeel met <nadruk>nadruk</nadruk>.</al></li>
                  </lijst>
                  <al>Slotzin na de lijst.</al>
                </lid>
              </artikel>
            </afdeling>
          </titeldeel>
        </boek>
      </wettekst>
    </wet-besluit>
  </wetgeving>
</toestand>`;

const parsed = parseBwbXml(xml);
assert.equal(parsed.bwbId, 'BWBRTEST');
assert.equal(parsed.inForceDate, '2026-07-01');
assert.equal(parsed.title, 'Testwet');
assert.equal(parsed.provisions.length, 1);

const provision = parsed.provisions[0];
assert.equal(provision.article, '628');
assert.equal(provision.provisionRef, '7:628');
assert.equal(
  provision.structurePath,
  'boek:7/titeldeel:10/afdeling:1',
);

const expected = [
  '1 In geval van elkaar opvolgende arbeidsovereenkomsten als bedoeld in artikel 668a kan een afwijking worden overeengekomen.',
  '2 Het minimumloon bedraagt:',
  'a. voor de toepassing van deze wet: per uur € 10,60 [Red: per 1 januari 2026: € 14,71] ;',
  'b. een tweede onderdeel met nadruk.',
  'Slotzin na de lijst.',
].join('\n');

assert.equal(provision.content, expected);
assert.ok(!provision.content.includes('artikel 668a In geval'));
assert.ok(!provision.content.includes('bedoeld inkan'));

console.log('BWB parser self-test passed.');
