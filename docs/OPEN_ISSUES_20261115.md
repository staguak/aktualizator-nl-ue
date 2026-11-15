# Stan roboczy i otwarte problemy — 2026-11-15

Zapis postępu na polecenie użytkownika. Kod pozostaje wersją roboczą, bez odbioru do publikacji danych. Przerwano dalsze naprawy; poniższe punkty nie są instrukcją automatycznej kontynuacji.

## Otwarte problemy

1. Ostatni pełny przebieg Node: **60/63 pliki testowe PASS**. Niepowodzenia: `drive-timeout.test.ts`, `public-command.test.ts`, `store-footprint.test.ts`. Przyczyn nie ustalono; nie potwierdzono jeszcze, czy dotyczą produktu, testów czy środowiska.
2. 75 dokumentów UE ma w zachowanych metadanych wyłącznie języki spoza EN/PL/NL/FR. Obecny mechanizm klasyfikuje je jako niedostępne i nadaje korpusowi status PARTIAL. Klasyfikacji nie zmieniano.
3. Nowy wybór dokumentów wyłączył podstawowy `32006L0054` jako dokument poza przedziałem i niewymaganą wersję bazową. Poprawność wyboru wersji bazowej i kompletność wymaganej historii pozostają do sprawdzenia.
4. Po ostatnich zmianach Formex nie wykonano świeżego wspólnego przebiegu NL/UE ani końcowego pełnego odbioru ostatecznego kodu. Starszy wspólny audyt PASS dotyczy wersji sprzed tych napraw.
5. Pełny przegląd bezpieczeństwa i gotowości całej wersji pozostaje otwarty. Kontrola plików przeznaczonych do push nie zastępuje pełnego odbioru.

## Zapisane poprawki Formex i dowody

- Oddzielono bajty i tożsamość XML członka od ścieżki, hashy i MIME kontenera ZIP.
- Język sprawdzany jest w bibliografii właściwego dokumentu; dla źródeł bez tego pola pozostaje kontrolowana informacja z nazwy własnego członka. Zachowano odrzucanie innego języka, CELEX i warstwy konsolidacji.
- Dodano obsługę CJT, CASE, CONCLUSION, JUDGMENT i fragmentów GENERAL oraz kontrolę identyfikatora sprawy.
- Osobne załączniki i fragmenty mają własne hashe, lokalizatory oraz powiązania z DOC.MAIN.PUB, DOC.SUB.PUB i INCL.ELEMENT. Każdy członek indeksowany jest raz, przy zachowaniu wszystkich wystąpień odwołań i wykrywaniu cykli/braków.
- Przypięto dokładne urzędowe XSD 5.50 i 6.02.3. Katalog zawiera 33 schematy; nowy profil XML unieważnia poprzednie wyniki walidacji, zachowując surowe źródła cache.
- Dodano niezależną kontrolę pakietów Formex w Pythonie oraz testy regresji i oryginalne małe paczki testowe z proweniencją.

Odbiór na zachowanych oryginałach: **124/124 różne paczki PASS, 324 XML PASS względem przypiętych schematów, 60 osobnych załączników, 35 845 obserwacji jednostek**. Odpowiada to 129 historycznym wystąpieniom ostrzeżenia; pięć paczek występowało w więcej niż jednej rodzinie. Zweryfikowano niezmienność oryginalnego ZIP po zapakowaniu i ponownym odczycie. To kontrola zachowanych źródeł, bez nowego pobierania pełnego korpusu.

Pozostałe wykonane kontrole: 18 testów integracji XML PASS, wcześniejsza ukierunkowana grupa 44 testów PASS, 111 testów Python PASS, obie kontrole TypeScript PASS w trakcie etapu. Po ostatnim drobnym rozszerzeniu obsługi DOC.SUB.PUB nie powtarzano wszystkich kontroli. Ostatnie źródła przeszły pełny odbiór 124 paczek już z tym rozszerzeniem.

## Materiały lokalne

W bieżącym środowisku materiały weryfikacji pozostają pod `/workspace/publication-review/formex-fix-20261115/`: `originals-results.json`, `originals.log`, `schema-pin.json`, logi testów oraz migawka plików sprzed zmian. Te dane wykonania, cache, checkpointy i pełne wyniki programu pozostają poza repozytorium Git. Starszy wspólny przebieg opisuje `PAIRED_RUN_20261115.md`; szczegóły wcześniejszych ostrzeżeń zawiera `EU_WARNINGS_ANALYSIS_20261115.md`.

Użyte umiejętności: Codex Engineering Guardrails — code-work; Codex Dev Workflows — bug-investigation. Exa pomogła znaleźć urzędową dokumentację schematów; oryginalne schematy pobrano bezpośrednio z CELLAR i przypięto ich SHA-256. Nie wykonano publikacji bazy, scalenia ani ustawienia harmonogramu.
