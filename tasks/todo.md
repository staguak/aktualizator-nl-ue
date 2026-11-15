# Etap 4 — postęp

## Zapis roboczy po zatrzymaniu — 2026-11-15

Aktualne otwarte błędy i zakres wykonanych poprawek: [docs/OPEN_ISSUES_20261115.md](../docs/OPEN_ISSUES_20261115.md). Analiza 160 ostrzeżeń i świeży wspólny przebieg zostały wykonane; wynik wspólnego przebiegu: [docs/PAIRED_RUN_20261115.md](../docs/PAIRED_RUN_20261115.md). Następnie poprawki Formex przeszły odbiór 124 oryginalnych paczek / 324 XML / 60 załączników. Pozostają trzy nieudane pliki testowe Node i pozostałe otwarte kwestie opisane w raporcie. Użytkownik zatrzymał dalsze naprawy; wersja jest robocza. Starsze listy poniżej są historią i nie stanowią aktualnego odbioru końcowego.

## Bieżące wznowienie — 2026-11-15

Poniższe starsze wyniki opisują historię prac. Nowszy wymóg Base64 w finalnym Markdown zastępuje wcześniejszą niezmienność prezentacji; niezmienność oryginalnych źródeł nadal obowiązuje.

- [x] Etap 2: odzyskanie klamry `r1.jpg` z PL; dowód aktu, wersji, kontekstu i natywnych bajtów. Raport: `docs/EU_FALLBACK_STAGE2_20261115.md`.
- [x] Obsługa braków dokumentów i grafik EN → PL → NL → FR, jawna kompletność PARTIAL, kontynuacja pozostałych pozycji; braki katalogów nie blokują prób skonfigurowanych identyfikatorów.
- [x] Etap 3: pełny tekst zamiast strukturalnych UE-REF, Base64, odwracalna prezentacja, MIME, SVG z zależnościami, indeks i niezależny audyt Python; raport: `docs/INLINE_BASE64_STAGE3_20261115.md`.
- [x] Rozróżnienie braków źródła od awarii/integralności cache, ponawianie niepełnych checkpointów, blokada promocji PARTIAL chroniąca poprawną bazę.
- [x] Korekta przed etapem 4: tytuły dokumentów i proweniencja, trzy niezależne daty, nagłówki UE sprawdzane z XHTML/surowymi metadanymi, cache i zweryfikowana migracja checkpointów, negatywne testy podmiany po przeliczeniu hashy. Raport: `docs/EU_DOCUMENT_HEADERS_20261115.md`. Końcowy pakiet UE: 65 pozycji / 135 dokumentów / 1663 pliki / 103 grafiki, walidacja aplikacji i niezależny audyt PASS, struktura i oryginały niezmienione. Regresja 390 Node / 111 Python PASS. Wspólnego przebiegu nie rozpoczynać przed zdaniem raportu użytkownikowi.
- [ ] Etap 4: świeży wspólny zakres i sparowany odbiór NL/UE. Osobne historyczne korpusy mają PASS, ale daty końcowe różnią się: 13 i 14 listopada. Przejrzeć zachowane 160 ostrzeżeń UE, w tym 129 odrzuceń Formex i 2 niepełne wyszukiwania Formex.
- [ ] Etap 5: PR / wymagany `verify` / ręczny test publiczny po przejściu lokalnego odbioru.
- [ ] Etap 6: rzeczywiste paczki Releases, indeks `dane`, cache i zwykłe sprzątanie; chroniona ostatnia poprawna baza. Bez eksperymentu retencji i harmonogramu.

## Historia wcześniejszych etapów

- [x] 1. Model jednostek, logiczne części i odtwarzanie; testy pozytywne/negatywne.
- [x] 2. Pełny strukturalny stan NL; tekst, wersje, tabele, przypisy, zasoby.
- [x] 3. Nowy renderer i manifest NL; granice naturalne i indeks.
- [x] Punkt kontrolny: odtworzenie pełnych wersji NL oraz zachowanie starych czytników.
- [x] 4. Strukturalne jednostki UE i podział bez progów znakowych/liczby artykułów.
- [x] 5. Manifest UE, nawigacja i deduplikacja.
- [x] 6. Walidacja źródło–model–wynik oraz checkpointy nowego/starego profilu.
- [x] Punkt kontrolny: odrzucenie braków, powtórzeń, błędnej hierarchii i wersji.
- [x] 7. Integracja publicznych wejść/cache i instalacji zweryfikowanych części.
- [x] 8. Regresja, kontrola typów, raport i pozostałe zadania.

## Dalsze etapy — zatwierdzona kontynuacja bez potwierdzeń

- [x] 5. Obrazy NL/UE, natywne bajty i IMAGE_INDEX; niezmienność Markdown.
- [x] 6. Audyt języków i kompletnego pakietu; zbiorcze źródła NL/UE.
- [x] 7. Releases, distribution, dane, runtime/cache i retencja w workflow.
- [ ] 8. Końcowa regresja, przegląd bezpieczeństwa, test publiczny i raport.

## Pozostały odbiór — użytkownik zlecił etap 2 i wyjątek dla flag dekoracyjnych

- [x] Pełna klasyfikacja brakujących grafik UE i dowody pochodzenia; zachować rygor kompletności. Raport: docs/EU_IMAGE_DIAGNOSIS_20261114.md; pełna lista 54 adresów w towarzyszącym CSV.
- [x] Bezpieczny transport HTTPS i prawidłowy Accept dla urzędowych obrazów; 31 aliasów CELLAR odzyskanych z identycznymi bajtami, natywna walidacja, cache 304 i testy bezpieczeństwa PASS. Dekoracyjne flagi pomijane na wyraźne polecenie użytkownika, z dokładną ewidencją w indeksie.
- [x] Domknięcie brakującego `r1.jpg` w załączniku VIII 01992L0058-20190726 — odzyskano PL 2026-11-15, z dowodem pochodzenia; EN nadal 404.
- [x] Domknięcie roboczej obsługi image/jpg, indeksów grafiki, walidacji pominiętych dekoracji i współdzielonych dokumentów w niezależnym audycie, diagnostyki i testów regresji — etap 3 z 2026-11-15.
- [ ] Kompletny odbiór UE oraz pary NL/UE: źródła, jednostki, obrazy, rekonstrukcja, regresja i niezależny audyt.
- [ ] PR, wymagany verify oraz pełny publiczny przebieg po spełnieniu kryteriów lokalnych.
- [ ] Kontrola paczek Releases, indeksu dane, cache i zwykłego sprzątania; aktualizacja raportu końcowego.

Szczegóły, narzędzia i kryteria: tasks/plan.md, sekcje „Wznowienie odbioru” oraz „Wynik etapu 2”. Użytkownik zatwierdził pomijanie dekoracyjnych flag; pozostałe grafiki nadal podlegają kontroli kompletności. Bez harmonogramu, zmiany prywatnego repo i osobnego eksperymentu retencji.

Etap 1 zakończony 2026-11-14: 130 wystąpień / 125 fizycznych, 54 adresy zewnętrzne. 31 adresów zwraca poprawne natywne JPEG po zmianie nagłówka Accept, z pełnym potwierdzeniem RDF i identycznością bajtów alias–CELLAR. Wszystkie 71 osadzonych JPEG jest poprawnych. Pozostają 22 adresy flagi i jeden znak grupowania tabeli. Dodatkowo pięć współdzielonych dokumentów ma dwa dopasowania w audycie wymagającym jednego. Brak zmian kodu w tym etapie; kolejne etapy nie zostały rozpoczęte.

Etap 2 wykonany w zakresie transportu i zatwierdzonego wyjątku: docs/EU_IMAGE_RECOVERY_20261114.md. 31/31 rzeczywistych pobrań PASS; następne żądania 31/31 HTTP 304, 3 164 777 bajtów z cache. Kontrola obrazów kandydata: 134/135 dokumentów PASS, 27 wystąpień flag / 22 URI pominięte jawnie, 1284 Markdown i manifest niezmienione. 45 testów Node + 2 Python oraz oba typechecki PASS. Jedyna blokada kompletności to `r1.jpg`; niezależny audyt nowych wpisów pozostaje do etapu 3. Bez publikacji i Actions.
