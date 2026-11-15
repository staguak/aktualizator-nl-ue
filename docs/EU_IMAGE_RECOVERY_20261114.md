# Etap 2 — urzędowe grafiki UE, 2026-11-14

Status: **poprawka transportu wykonana i sprawdzona lokalnie; pełny pakiet nadal blokuje jedna wymagana grafika tabeli**. Zmiany pozostają w roboczej gałęzi `fix-eu-native-images-20261114`, baza `ccc6363b73dac766045c1fe5411c514a563fe64d`. Nie wykonano publikacji, push, PR ani Actions.

## Zmiany

`aktualizator-ph/src/package-images.ts`:

- Źródłowe identyfikatory HTTP na dwóch znanych hostach UE (`publications.europa.eu`, `eur-lex.europa.eu`) są pobierane przez HTTPS. Oryginalny URI nadal występuje w dowodzie źródłowym indeksu i w niezmienionym Markdown.
- Zamiast odrzucanego przez CELLAR `Accept: image/*` wysyłany jest konkretny MIME wynikający z rozszerzenia; dla elementu bez rozszerzenia używane jest `*/*`.
- Każda odpowiedź jest sprawdzana natywnym dekoderem. HTML z HTTP 200 ani uszkodzony JPEG nie stają się grafiką. Brak konwersji formatów i zmiany bajtów.
- Zachowano ograniczenia hostów/przekierowań, kontrolę portów i zakaz danych uwierzytelniających w URI. Przekierowanie do obcego hosta jest odrzucane przed wysłaniem kolejnego żądania.
- Zachowano warunkowy cache i limit pojedynczej grafiki 95 000 000 bajtów. SVG korzysta z jawnej ścieżki cache plikowego, aby jego MIME `image/svg+xml` nie uruchamiał zasady braku limitu dla surowych RDF/XML. Zasady pobierania rzeczywistych źródeł RDF/XML pozostają bez zmian.

Nie dodano obowiązkowego SPARQL przy każdym pobraniu. Dla wszystkich 31 dostępnych adresów poprawne żądanie do oryginalnego aliasu dociera do dokładnie tego kanonicznego elementu CELLAR, który potwierdzono w RDF w etapie 1, i daje identyczny SHA-256.

## Decyzja użytkownika: pomijanie dekoracyjnych flag

W trakcie etapu użytkownik wyraźnie zrezygnował z wymogu pobierania dekoracyjnych flag. Ta decyzja zastępuje nierozstrzygnięty wyjątek opisany w raporcie z etapu 1.

`src/legal-images.ts` pomija pobieranie rozpoznanej flagi nagłówka Dziennika Urzędowego UE. Warunki obejmują kontekst nagłówka, nazwę zasobu `europeanflag.gif`, opis obrazu, urzędowy host i brak osadzenia w artykule/załączniku lub innej merytorycznej jednostce. Rozpoznawane są tytuły nagłówków EN/PL/NL/FR.

`IMAGE_INDEX.json` otrzymuje opcjonalną listę `omittedDecorations`. Wpis zawiera powód `decorative-european-flag`, URI obrazu, dokument, wersję, język, SHA oryginału i Markdown, plik, pozycje UTF-16, jednostkę prawną i lokalizator. Nie udaje pobranego źródła ani nie wskazuje nieistniejącej grafiki. Walidator TypeScript odtwarza klasyfikację z treści i odrzuca brakujące, nadmiarowe lub podmienione wpisy.

Oryginałów, odwołań i Markdown nie zmieniono. Starsze indeksy bez tej listy zachowują dotychczasową ścieżkę odczytu. Wyjątek nie obejmuje wzorów, klamer tabel ani ilustracji w artykułach. Niezależną walidację nowych wpisów w Pythonie należy domknąć w etapie 3 przed odbiorem całego pakietu.

## Wyniki weryfikacji

| Kontrola | Wynik |
| --- | --- |
| Pobranie przez rzeczywisty loader programu | 31/31 dostępnych adresów; zgodne natywne bajty i kanoniczne URI z dowodów RDF |
| Ponowne żądania po zapisaniu izolowanego cache | 31/31 HTTP 304; ponownie użyto 3 164 777 bajtów obrazów bez przesyłania ich treści |
| Kontrola obrazów w pełnym lokalnym kandydacie UE | 134/135 dokumentów PASS; 1 dokument zatrzymany przez wymagany `r1.jpg` |
| Dekoracyjne flagi | 27 wystąpień pod 22 adresami jawnie pominięte, bez próby pobrania |
| Niezmienność kandydata | SHA wszystkich 1284 odczytanych Markdown i bajty manifestu bez zmian |
| Testy Node: transport, grafiki, cache, wyjścia UE i NL | 45 PASS w sześciu plikach testów |
| Natywna walidacja grafik Python | 2 PASS |
| TypeScript aplikacji i narzędzi | Oba sprawdzenia PASS |

Pierwotne testy transportu odtworzyły odrzucanie źródłowego HTTP przed poprawką. Dodatkowy test wykazał obchodzenie limitu SVG przez ogólną heurystykę XML w cache; poprawka jawnego wyboru API cache usuwa ten problem. Testy obejmują również blokowanie niebezpiecznych adresów/przekierowań, HTTP 404/202, HTML z HTTP 200, zachowanie natywnych bajtów, cache 304 w obu trybach, niezmienność Markdown, granice wyjątku dla flag oraz odrzucanie podmiany indeksu.

Kontrola 135 dokumentów dotyczy obrazów i ich kontekstu w istniejącym kandydacie `/workspace/publication-review/acceptance2/offline-eu`. Nie zastępuje pełnego niezależnego audytu źródeł ani odbioru sparowanych NL/UE. Nie wygenerowano ani nie zainstalowano niekompletnego wydania. Aktywna publiczna baza pozostaje bez zmian.

## Pozostała blokada i dalsze zadania

`01992L0058-20190726`, załącznik VIII: `http://publications.europa.eu/resource/celex/01992L0058-20190726.ENG.xhtml.r1.jpg`, opis `right accolade`. Po poprawieniu transportu i Accept serwer nadal odpowiada HTTP 404. Jest to klamra grupująca komórki tabeli; oryginalny Formex potwierdza `ACCV="004.R.R"`, `ROWSPAN="4"`. Wyjątek dla flag jej nie obejmuje.

Nie zastąpiono jej podobną grafiką ani nie oznaczono dokumentu jako kompletnego. Pozostaje odzyskanie dokładnego urzędowego zasobu albo osobne rozstrzygnięcie wiernej reprezentacji tej struktury na podstawie oryginału Formex. Wyszukiwanie Exa nie dostarczyło nowego wiążącego adresu tej grafiki.

Kolejny etap obejmuje domknięcie indeksów i niezależnego audytu (w tym jawnych pominięć oraz dokumentów współdzielonych), roboczej obsługi `image/jpg` i regresji. Następnie pełny odbiór NL/UE, wymagane CI/test publiczny i kontrola dystrybucji. Pełna regresja wszystkich testów i publiczny przebieg pozostają do wykonania zgodnie z planem.

## Dowody i użyte umiejętności

Lokalny katalog `/workspace/publication-review/stage2-eu-images/`:

- `live-images-first.json` — pierwsze rzeczywiste pobranie obrazów;
- `live-images.json` — ponowne żądania przy końcowej wersji kodu, obserwacje HTTP i SHA natywnych grafik;
- `corpus-images.json` — wyniki 135 dokumentów i wszystkie 27 jawnych pominięć;
- `stage2-summary.json` — liczniki, SHA kodu oraz plików dowodowych;
- logi testów i kontroli typów; skrypty reprodukcji i izolowany cache w `source-cache/`.

Wykorzystano Codex Dev Workflows: `resume-interrupted-task` do odtworzenia stanu i zachowania wcześniejszych zmian, `bug-investigation` do minimalnej naprawy przyczyn oraz `feature-testing` do sprawdzenia kontraktów i regresji. Wtyczkę Exa wykorzystano do poszukiwania dokładnego urzędowego zasobu. Prób rzeczywistego pobierania dokonano kodem programu przez HTTPS, a walidacji lokalnym Node/Python/Pillow. Nie używano narzędzi GitHub do zmian zdalnych.

Wcześniejsze robocze zmiany `eu-assets.ts`, ich test i oryginalna próbka JPEG pozostały zachowane; nie pochodzą z tego etapu. Nie zmieniano harmonogramu, retencji, sekretów ani prywatnego repozytorium.
