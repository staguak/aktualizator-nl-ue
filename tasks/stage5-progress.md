# Etap 5 — grafiki

Zaimplementowano `legal-images.ts`, `package-images.ts`, niezależny `validate_image.py` (Pillow 12.3.0 dla bitmap, XML dla SVG). Oryginały i zweryfikowany Markdown pozostają identyczne; jedna grafika pod SHA-256 może obsłużyć wiele wystąpień. IMAGE_INDEX wiąże każde wystąpienie z plikiem i jego SHA, źródłem i jego SHA, wersją, językiem, jednostką i kontekstem, zakresem oraz natywnymi bajtami. Zewnętrzne pobrania zachowują osobny dowód URL→SHA/size; obce adresy obrazów są odrzucane przez publiczny loader. INDEX wskazuje grafiki i indeks maszynowy. Walidator odczytuje pakiet obrazów i inwentarz podkatalogu images; starsze pakiety nadal są obsługiwane.

Publiczny github-build dodaje grafiki po walidacji Markdown i przed finalnym audytem/promocją. Bitmap nie konwertuje się, rzeczywisty format określa dekoder. Inline SVG otrzymuje brakujący kontekst xmlns wyłącznie w pliku bocznym; źródłowy Markdown pozostaje niezmieniony. Aktywny lub nieprawidłowy SVG oraz uszkodzone obrazy blokują wynik.

Pierwszy pełny przebieg: 335 testów Node, 2 Python obrazów i obie kontrole typów PASS. Niezależny przegląd wykazał 3 Important: pomijanie adresów CSS bez rozszerzenia, brak namespace standalone SVG, możliwość zamiany celów dwóch obrazów zewnętrznych. Wszystkie odtworzono testami RED, naprawiono, 6/6 testów grafiki PASS. Nowa końcowa regresja potrzebna po integracji etapu 6. Nie było Critical ani odłożonych Minor.

Ruling: nie rozpoznajemy obrazów po rozszerzeniu URL ani deklarowanym MIME — pobieramy referencje CSS, poza jawnym @font-face/@import i lokalnymi paint-server fragmentami, oraz weryfikujemy natywny format. Nieznany/uszkodzony format blokuje kompletność zamiast znikać. Koszt: wymagany decoder/runtime; jawny błąd dla niewspieranego obrazu.

Reviewer nie oceniał późniejszych Releases/workflow, żywego korpusu ani pełnej semantyki dziedziczenia stylów SVG. Zachowanie dokładnych bajtów nie jest obietnicą identycznego renderowania SVG we wszystkich przeglądarkach; źródłowy kontekst i Markdown są zachowane. Dalsze etapy pozostają w tasks/plan.md.
