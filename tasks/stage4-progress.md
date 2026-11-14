# Etap 4 — kontynuacja 2026-11-14

Zakres i kryteria: `tasks/plan.md`; źródłem decyzji są ostatnie ustalenia użytkownika. Istniejące zmiany etapów 1–3 zachowujemy. Bez publikacji, commit/push, Actions ani harmonogramu.

## Dobór wtyczek

| Krok | Instrukcje/narzędzia | Powód |
|---|---|---|
| Odtworzenie i diagnoza NL | Codex Dev Workflows resume-interrupted-task; Superpowers systematic-debugging | Odtworzenie faktów, przyczyna przed poprawką |
| Model/parser/renderowanie NL i UE | EngineeringSuite tdd; Superpowers test-driven-development; Codex Engineering Guardrails code-work | Testy na uzgodnionych granicach parser → wynik → manifest → rekonstrukcja, najmniejsza spójna zmiana |
| Wzorce nagłówków EN/PL/NL/FR | SimplyUtils test_regex | Pomocniczy niezależny przebieg na jawnych przykładach; nie zastępuje testów parsera |
| Końcowa kontrola etapu | Superpowers verification-before-completion; Codex Engineering Guardrails code-verification | Świeże wyniki, jawne błędy i ograniczenia |
| Przed publikacją (późniejszy etap) | Security Advisory Scout; audyt workflow | Wersje zależności/advisories i uprawnienia; teraz bez zmiany zależności |

Programming Hub, Matt Skills Curated, OGENIC GOD TOOLKIT i Prompt Machine: nie znaleziono dostępnych instrukcji/narzędzi w bieżącym odkrytym katalogu; nie udajemy użycia. Katalog zgłosił ograniczenie kompletności. SimplyUtils Base64 zwraca tekst UTF-8, więc nie nadaje się do bezstratnego zapisu binarnych obrazów — użyć lokalnego dekodera bajtów w etapie obrazów.

## Stan i dowody

- Model wspólny oraz parser NL: poprzednie testy przechodzą; wymagają ponownej kontroli po integracji.
- Błąd integracji NL odtworzony: fixture tworzył katalog checkpoint wewnątrz katalogu wyniku. Walidator słusznie odrzuca dodatkową pozycję spoza manifestu. Poprawiamy izolację fixture, nie osłabiamy walidatora.
- Interfejsy: parser→draft→finalny manifest; zakresy liczyć po finalnej nawigacji; checkpoint→oryginały→ponowna kontrola; stare konfiguracje zachowują starą ścieżkę.
- Wzorzec artykułu SimplyUtils: poprawnie rozpoznał Article 1 / Artykuł 2 / Artikel 3a / Article premier; pominął odwołanie w zwykłym zdaniu i ANNEX I.

## Kolejne wyniki

- NL integracja 2/2 PASS po poprawie izolacji fixture; nie zmieniono walidatora inwentarza w celu zamaskowania błędu.
- UE: poprawiono zagnieżdżanie kolejnych załączników; ELI art_1.tit_1 nie staje się artykułem; pełny numerowany akapit orzeczenia zawiera tabelę. Dodano testy, obserwowano RED→GREEN.
- Odtwarzanie UE i checkpointy porównują wynik z oryginalnym XHTML. Deduplikacja zachowuje własne ID wersji oraz lokalizacje w kanonicznych plikach. Łączenie części strukturalnych nie dodaje spacji ani nowych linii do treści.
- Publiczne konfiguracje: 23 NL i 65 UE mają legal-structure-v1; selektory i piny bez zmian.
- Pełne npm test: 328/328 PASS (wymagana dostępność lokalnej sieci dla testowego serwera HTTP). Pierwszy przebieg bez dostępu do sieci ujawnił EPERM w testach serwera/procesów; kontrolne przebiegi z dostępem PASS. Regresja diagnostycznych starszych archiwów poprawiona przez stosowanie nowego kontrolera tylko do dokumentów nowego profilu. Fixture WEMI dopasowany do czterech języków przy zachowaniu jednego odczytu angielskiego indeksu.
- Python public: 44/44 PASS. XML Python: 34/34 PASS. XML integracja Node: 14/14 PASS po wskazaniu .venv/bin/python; systemowy Python nie miał przypiętego runtime i słusznie blokował walidację.
- Rzeczywiste zapisane źródła: C-19/23 judgment, opinion, dyrektywa 32008L0104 NL; integralność i odtwarzanie po finalizacji PASS. Szczegóły /workspace/publication-review/step4/real-sources.json. To nie jest pełny korpus ani publiczny przebieg.
- Parser BWB selftest PASS; obie kontrole typów przechodziły przed ostatnią zmianą indeksu; ponowna kontrola w toku.

## Niezależny przegląd i poprawki

Superpowers requesting-code-review: niezależny reviewer bez zmian w plikach zgłosił cztery Important, zero Critical. Naprawiono: semantyczną numerację list (`type/start/reversed/value`), pozycje komórek CALS i zajęte kolumny rowspan (nieobsługiwany układ blokuje wynik), numery starszych akapitów C01Pointnumerote, zachowanie kontenerów dopasowanych selektorami CSS white-space (ID/typ/atrybut/klasa; przy niepewności zachować kontenery). Testy reprodukują wskazane przypadki, potem PASS; końcowa regresja ponownie uruchamiana.

Reviewer nie oceniał etapów 1–3, obrazów/Releases/workflow, całego korpusu ani działania żywych dostawców; nie powtarzał pełnego zestawu. Te zakresy wymagają własnych dowodów w kolejnych etapach. Nie zgłoszono odłożonych drobnych usterek. Nie wprowadzono zmian poza zatwierdzonym zakresem.
