# Etap 3 — Base64, pełna treść i niezależna walidacja, 2026-11-15

Status: etap 3 zakończony lokalnie. Zakres: publiczny aktualizator NL/UE, robocza gałąź `fix-eu-native-images-20261114`, baza `ccc6363b73dac766045c1fe5411c514a563fe64d`. Prace i próby wykonano lokalnie. Nie wykonano push, PR, Actions, merge ani publikacji. Prywatnego repozytorium i harmonogramu nie zmieniano; nie wykonywano eksperymentu retencji.

## Zrealizowane zachowanie

Finalny strukturalny Markdown zawiera grafiki jako Base64. Natywne JPEG, PNG i pozostałe obsługiwane formaty nie są konwertowane do JPEG ani ponownie kompresowane. Odwołania do grafik w HTML, CSS i SVG są zastępowane osadzonymi bajtami. Fragmenty adresów, np. `#symbol`, pozostają zachowane. Lokalne powiązania SVG pozostają lokalne. Publiczne strukturalne pliki UE zawierają pełną treść także wtedy, gdy źródło jest współdzielone przez kilka zakresów; nie powstają dla nich pliki UE-REF zawierające sam odnośnik. Pobieranie i parsowanie tego samego źródła nadal można współdzielić.

Oryginalne dokumenty i archiwa źródeł pozostają niezmienione. Zmianie podlega prezentacja finalnego Markdown, zgodnie z nowszym wymaganiem użytkownika. `IMAGE_INDEX.json` zachowuje natywne grafiki, powiązania z dokumentem, wersją i jednostką prawną oraz dokładny przepis odwrócenia zmian. Profil `inline-base64-v1` rozróżnia fizyczny wynik od kanonicznego tekstu prawnego. Rozmiary i MD5 dotyczą fizycznych plików; lokalizatory jednostek dotyczą odtworzonej kanonicznej treści. Nie zmieniono logicznych zasad podziału aktu.

Przepis rekonstrukcji używa zakresów UTF-16 i sum SHA-256. Przechowuje tylko zmienione fragmenty, ograniczając powielanie istniejących dużych ładunków Base64. TypeScript ponownie generuje prezentację z kanonicznego tekstu i zweryfikowanych grafik. Niezależny Python sprawdza rekonstrukcję, bajty Base64, MIME, atrybuty, kontekst, CSS oraz geometrię i treść SVG. Podmiana treści lub geometrii jest odrzucana również po przeliczeniu samych sum prezentacji.

SVG zawierający kolejne grafiki otrzymuje samowystarczalną pochodną, bez zmiany formatu wektorowego. Profil `self-contained-svg-v1` zachowuje dokładne oryginalne bajty SVG, grafiki zależne, adresy źródłowe i ewentualne kolejne pochodne. Zależności `image`, `feImage`, zewnętrzne `use` i graficzne CSS są osadzane rekurencyjnie; cykle i nadmierna głębokość są odrzucane. Naprawiono pomijanie `feImage` przez selektory oraz zamianę tego elementu na `span` podczas renderowania drzewa. Oryginały SVG i zależności trafiają również do tej samej zbiorczej paczki źródeł NL albo UE. Pochodna SVG jest wyraźnie odróżniona od oryginału w indeksie.

## Braki i bezpieczeństwo istniejącej bazy

Po wyczerpaniu skonfigurowanych prób EN → PL → NL → FR brak dokumentu lub grafiki jest jawnie oznaczony i pozostałe pozycje nadal są przetwarzane. Nie powstaje fałszywa treść ani martwy odnośnik zastępujący grafikę. Zatwierdzony wyjątek dotyczy tylko dekoracyjnych flag nagłówków Dziennika Urzędowego UE.

Niedostępny katalog odkrywania źródeł nie blokuje prób pobrania skonfigurowanych identyfikatorów; wynik ma dowód niepełnego rozpoznania zakresu. Błędy dysku, walidatora, konfiguracji i integralności cache są propagowane jako awarie, zamiast być maskowane jako brak źródła w czterech językach.

Niepełne checkpointy pozostają na dysku jako dowód próby, lecz ich braki są ponownie sprawdzane przy wznowieniu. Kompletne akty nadal nadają się do ponownego użycia. Walidacja integralności dostępnej części może zakończyć się PASS przy jawnej kompletności PARTIAL; te pojęcia są rozdzielone. Dodatkowa blokada `OUTPUT_INCOMPLETE` zatrzymuje promocję niepełnego zestawu na aktywną publiczną bazę, zanim nastąpi przesyłanie wydania i zmiana `dane`. Pozostałe dokumenty są wcześniej przetwarzane, a zwykła obsługa nieudanej próby zachowuje raport/runtime oraz dotychczasową poprawną bazę.

Wspólna paczka źródeł zawiera także oryginalny XHTML użyty do odzyskania grafiki z innego języka oraz źródła pochodnych SVG. Nie dodano kolejnych osobnych archiwów: nadal przewidziane są `NL-results.zip`, `UE-results.zip`, `NL-sources.zip`, `UE-sources.zip`.

## Sprawdzenie rzeczywistych danych

Kandydat powstał z zachowanych, wcześniej pobranych oryginałów. To próba rekonstrukcji i nowej prezentacji, a nie świeże pobranie bieżącego zakresu ani opublikowana aktualizacja.

| Właściwość | NL | UE |
| --- | ---: | ---: |
| Akty / pozycje zakresu | 23 | 65 |
| Pliki strukturalnego Markdown | 4871 | 1358 |
| Zmienione pliki Markdown | 11 | 39 |
| Wystąpienia grafik | 58 | 103 |
| Różne natywne grafiki | 20 | 101 |
| Jawnie pominięte dekoracyjne flagi | 0 | 27 |
| Niedostępne dokumenty / grafiki | 0 / 0 | 0 / 0 |
| Pliki oryginalnych źródeł | 144 | 539 |
| Bajty oryginalnych źródeł | 203256600 | 397790222 |
| Pliki całego zestawu | 4986 | 1663 |
| Zakres | 2025-01-01–2026-11-13 | 2025-01-01–2026-11-14 |

Archiwa źródeł zachowały identyczne SHA-256 przed i po operacji. Rekonstrukcja kanonicznej treści i niezależny audyt każdego korpusu przeszły. Brakująca klamra załącznika VIII `01992L0058-20190726` została odzyskana z polskiego oryginału w etapie 2 i jest obecna w kandydacie UE.

**Różne daty końcowe oznaczają brak sparowanego odbioru publikacyjnego.** Nie zmieniano dat w manifestach, aby uzyskać PASS. Następny etap wymaga wspólnego rzeczywistego zakresu i pełnej kontroli pary NL/UE.

## Zachowane ostrzeżenia

Historyczne źródła UE zawierają 160 wpisów ostrzeżeń, a NL 0:

- 129 `FORMEX_REJECTED` — walidator odrzucił opcjonalną reprezentację Formex; zachowano pełny XHTML.
- 25 `TEXT_LANGUAGE_FALLBACK` — tekst dostępny w jednym z dozwolonych języków rezerwowych.
- 2 `FORMEX_LOCATION_FAILED` — nieukończone rozpoznanie opcjonalnego Formex.
- 4 `FORMEX_NOT_PUBLISHED` — puste wyniki sprawdzonych indeksów Formex; zachowano XHTML.

To wpisy z użytych historycznych źródeł, a nie nowe alerty bezpieczeństwa GitHub ani nowe utraty spowodowane Base64. Przyczyny odrzuceń Formex oraz dwóch niepełnych wyszukiwań wymagają przeglądu w następnym etapie; nie deklarujemy usunięcia wszystkich ostrzeżeń. Zestawy są kompletne względem zweryfikowanych dokumentów XHTML, co nie oznacza dostępności każdego opcjonalnego formatu źródłowego.

## Weryfikacja i dowody

Końcowa regresja: **385 testów Node w 61 plikach PASS, 107 testów Python PASS, obie kontrole TypeScript PASS, self-test BWB PASS, 14 testów integracyjnych XML PASS, `git diff --check` PASS**. Dodatkowo ponowna walidacja aplikacyjna 4986 plików NL i 1663 plików UE oraz niezależne audyty obu korpusów zakończyły się PASS. Wynik dotyczy osobnych historycznych kandydatów, bez zatwierdzenia ich jako wspólnej publikacji.

Wyniki i logi zapisano w `/workspace/publication-review/20261115-stage3/`:

- `verified-svg/node-results.json`: pełna regresja Node.
- `verified-python.log`: pełna regresja Python.
- `typecheck-final.log`, `typecheck-tools-final.log`: obie kontrole typów.
- `parser-selftest-final.log`, `xml-integration-final.log`: self-test parsera i integracja XML.
- `candidate-result.json`: liczby grafik, plików i niezmienność archiwów.
- `candidate-validation-final.json`: ponowna walidacja aplikacyjna kandydatów.
- `independent-corpora-final.json`: niezależny audyt obu historycznych korpusów, `pairedRange: false`.
- `source-warnings.json`: zachowane ostrzeżenia i klasyfikacje.

## Pozostałe etapy

4. Świeży wspólny zakres NL/UE, przegląd ostrzeżeń źródłowych i pełny sparowany odbiór; potwierdzenie rzeczywistego ponownego użycia danych/cache.
5. PR, wymagany `verify` i uzgodniony ręczny test GitHub Actions po przejściu lokalnych kryteriów. Bez harmonogramu.
6. Sprawdzenie opublikowanych paczek Releases, indeksu `dane`, cache, blokady uruchomienia i zwykłego sprzątania dwóch ostatnich prób oraz chronionej poprawnej bazy. Bez osobnego eksperymentu retencji.

Faktycznie użyte umiejętności: Codex Dev Workflows `resume-interrupted-task` do odtworzenia stanu, `feature-development` do implementacji i `code-review` do przeglądu zmian. Router `platform-guidance` odczytano, ale wskazany zasób platformowy nie był dostępny; polecenia potwierdzono z konfiguracji repo. Weryfikację wykonano lokalnymi Node 24 i Python oraz narzędziami wykonawczymi MCP. Nie używano narzędzi dodatkowych usług/wtyczek badawczych ani delegowania do agentów.
