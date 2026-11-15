# Wspólny przebieg NL/UE — 2026-11-15

Przebieg zakończony: **PASS, kod wyjścia 0; niezależny audyt PASS**. Kompletność jest osobną oceną: **NL COMPLETE, UE PARTIAL**. Ponowne uruchomienie nie usunęło odrzuceń Formex. Nie zastosowano napraw z analizy ostrzeżeń.

## Warunki wykonania

- Wspólny zakres obu modułów: **2025-01-01–2026-11-15**, data obserwacji 2026-11-15.
- 23 akty NL i 65 pozycji konfiguracji UE.
- Początek 19:26:36 UTC, koniec 19:55:40 UTC; około **29 minut 4 sekundy**.
- Lokalna, izolowana kopia aktualnego kodu z gałęzi `fix-eu-native-images-20261114`; ref HEAD `ccc6363b73dac766045c1fe5411c514a563fe64d`. Uwzględniono istniejące, niezacommitowane poprawki nagłówków i Base64.
- Uruchomiono `node --import tsx src/github-build.ts`, czyli publiczny punkt wejścia używany przez Actions. Samych GitHub Actions nie uruchamiano.
- Wykonano nowe wyszukiwanie i warunkową rewalidację źródeł. Zachowano cache: odtworzono cache wyników pośrednich i ogrzano cache źródeł z 524 zweryfikowanych reprezentacji wcześniejszej bazy. Nie wczytywano starego checkpointu jako zakończonego nowego przebiegu. Nie był to test pobierania wszystkiego bez cache.
- Proces otrzymał środowisko bez tokenów GitHub i poświadczeń Drive. Nie wykonano zdalnej publikacji, push, merge, zmiany harmonogramu ani testu retencji.
- Końcowe porównanie SHA-256 potwierdza niezmienność plików programu objętych migawką. Istniejące modyfikacje robocze zachowano.

## Wyniki

| Miara | NL | UE |
| --- | ---: | ---: |
| Akty / pozycje konfiguracji | 23 | 65 |
| Wersje / wystąpienia dokumentów | 68 | 134 |
| Pliki końcowe po osadzeniu grafik | 4986 | 1722 |
| Ostrzeżenia źródeł | 0 | 234 |
| Wpisy o niedostępnych dokumentach | 0 | 75 |
| Nieukończone katalogi | 0 | 0 |
| Wystąpienia grafik w indeksie | 58 | 103 |
| Niedostępne grafiki | 0 | 0 |
| Kompletność według audytu | COMPLETE | PARTIAL |

Łącznie zamrożono **6708 plików**. UE nie wygenerował plików zastępczych UE-REF. Audyt wykazał 143 źródłowe pliki NL i 613 UE; zaakceptowanych paczek Formex w pakiecie UE nadal jest **0**. PASS potwierdza przejście kontroli zachowanych wyników i źródeł, a nie pomyślne przyjęcie odrzuconych reprezentacji ani pełny zakres wszystkich języków.

Log przed osadzeniem Base64 podaje 4965 plików NL i 1620 UE. Dodatkowe pliki powstały podczas finalizacji pakietów graficznych; końcowe liczby pochodzą z niezależnego audytu.

Cache parsera odnotował NL: 68 trafień / 136 obliczeń; UE: 268 trafień / 157 obliczeń. Są to liczniki parsera, nie liczby pobrań HTTP ani kompletne statystyki wszystkich warstw cache. Końcowa walidacja zajęła znaczną część czasu; jej szczegółowego profilu wydajności nie mierzono.

## Ostrzeżenia i porównanie

| Kod | Poprzedni analizowany pakiet | Nowy przebieg |
| --- | ---: | ---: |
| FORMEX_REJECTED | 129 | 128 |
| FORMEX_NOT_PUBLISHED | 4 | 6 |
| FORMEX_LOCATION_FAILED | 2 | 0 |
| TEXT_LANGUAGE_FALLBACK | 25 | 25 |
| DOCUMENT_UNAVAILABLE | 0 | 75 |
| Razem | 160 | 234 |

**Wszystkie 128 bieżących odrzuceń Formex występowały również poprzednio w tych samych rodzinach i dokumentach.** Spadek 129 → 128 nie oznacza odzyskania Formex. W nowym wyborze nie uwzględniono `32006L0054`: zapisany powód to „Outside documentary date interval and not the required baseline version”. W tej rodzinie pozostają `02006L0054-20260619` i `32024L1500`. Względem poprzedniego pakietu liczba wystąpień dokumentów zmieniła się 135 → 134, bez dodanych wystąpień. Nie naprawiano ani nie zmieniano tej polityki wyboru.

Poprzedni kandydat UE kończył zakres 2026-11-14, a obecna wspólna para kończy go 2026-11-15. Dlatego tabela jest porównaniem komunikatów i tożsamości dokumentów, nie testem identycznych wejść historycznych. W nowym przebiegu oba moduły mają identyczne granice dat.

Wszystkie **75** niedostępnych dokumentów to różne CELEX. Zachowane dla nich metadane `available_language` nie wskazują żadnego z EN/PL/NL/FR; wskazują inne języki. Przykłady: `02003L0088-20031118` i `32003L0088R(01)` — HUN; `02008L0104-20081205` — SLK. Program podjął próby w czterech ustalonych językach, zachował opis problemu i kontynuował. To nie jest dowód braków 75 dokumentów dostępnych w dozwolonych językach. Obecny mechanizm kompletności mimo to oznacza cały pakiet UE jako PARTIAL. Nie rozszerzano języków ani nie zmieniano klasyfikacji.

Ponowny przebieg potwierdza utrzymywanie się odrzuceń Formex. Sam ten test nie ustala pełnej historii dostępności usługi ani nie wyklucza wcześniejszej awarii zewnętrznej. Nie unieważnia też odtworzeń błędów na zachowanych bajtach opisanych w `EU_WARNINGS_ANALYSIS_20261115.md`. Zgodnie z poleceniem użytkownika ewentualne naprawy pozostają do dalszej decyzji.

## Paczki i dowody

Katalog przebiegu: `/workspace/publication-review/paired-20261115T192636Z`.

- `run.json` — zakończenie, zakres i wynik kontroli niezmienności kodu.
- `public-build.log` — pełny log programu; działanie monitorowano na bieżąco.
- `app/.public-state/independent-audit.json` — niezależny audyt obu korpusów.
- `app/.public-state/validated-files.json` — zamrożony wykaz 6708 plików z rozmiarami i SHA-256.
- `app/.public-state/distribution/distribution.json` — cztery zweryfikowane paczki, hashe oraz osobna ocena kompletności.
- `app/output/`, `app/output-ue/` — finalne wyniki lokalnego testu. Nie zastąpiły publicznej bazy na GitHub.
- `source-issues.json`, `missing-documents.json`, `missing-language-summary.json`, `formex-comparison.json`, `document-comparison.json` — dane porównania.
- Cache, checkpointy oraz diagnostyka odrzuceń pozostały w izolowanym `app/`.

| Paczka | Bajty | SHA-256 |
| --- | ---: | --- |
| NL-results.zip | 62351110 | f24e980604f34afefa51d158307fd9ad667662f7860d0da3d095e72ab7f5f1be |
| NL-sources.zip | 34265652 | 4d8de856910cfc62326a498e0180d5be2f72841ec0b90ebd550ded97327a2f94 |
| UE-results.zip | 34364288 | 7271e4c13cfa185f66a7ca56c5af994d0279f98662b27f6f00df5ae0be260464 |
| UE-sources.zip | 39809883 | 13430d78f42d524e36113770cca1ee62dc5db374e4468d1544327f3e6230bb52 |

W trakcie pracy, z powodu małej ilości miejsca na `/workspace`, przeniesiono wyłącznie własny historyczny cache analizy nagłówków do `/tmp/publication-review-preserved/20261115-eu-headers-derived-cache`. Zachowano ścieżkę przez dowiązanie oraz zweryfikowano SHA-256 wszystkich 260 plików (240019181 bajtów). Potwierdzenie: `scratch-relocation.json`. Nie usuwano cache ani checkpointów bieżącego programu. `/tmp` pozostaje lokalnym, nietrwałym magazynem tego środowiska.

## Użyte umiejętności i narzędzia

**Codex Dev Workflows — `resume-interrupted-task`**: odtworzenie miejsca zakończenia poprzedniej pracy, sprawdzenie refów i zachowanie istniejących modyfikacji. Użyto lokalnych Node.js 24.22.1, przypiętego środowiska Python, terminala i połączeń HTTPS samego aktualizatora do oficjalnych źródeł. Nie używano dodatkowych wtyczek badawczych ani narzędzi do zdalnej modyfikacji GitHub: do tego etapu wystarczały kod, źródła i diagnostyka programu.

Następny krok to decyzja po ocenie świeżego wyniku, w szczególności powtarzających się odrzuceń Formex oraz klasyfikacji dokumentów dostępnych wyłącznie poza dozwolonymi językami. Ten etap nie obejmował napraw tych zachowań.
