# Modo AR — Prova de Conceito WebXR

POC de realidade aumentada com rastreamento espacial: WebXR `immersive-ar` + hit-test +
âncora espacial, renderizado com Three.js. Um único objeto 3D, sem backend, sem banco,
sem login.

## Estrutura

```
index.html                     interface + importmap do Three.js
style.css                      estilos (tela inicial e HUD da AR)
app.js                         bootstrap, verificação de suporte, ligação da UI
src/ar-experience.js           AR ENGINE: sessão, hit-test, âncora, seleção, loop
src/placement-guide.js         orientação de varredura + contorno do plano (plane-detection)
src/explode.js                 vista explodida: separa as peças do equipamento
src/occlusion.js               oclusão por profundidade (WebXR Depth Sensing)
src/hand-occlusion.js          oclusão da mão por silhueta dos landmarks
src/gestures.js                GESTURE ENGINE (touchscreen)
src/hand/index.js              seleção do provider de hand tracking
src/hand/native-hand.js        HAND TRACKING via WebXR Hand Input
src/hand/mediapipe-hand.js     HAND TRACKING via MediaPipe + camera-access
src/hand/hand-analyzer.js      landmarks -> sinais de gesto estabilizados
src/hand-controller.js         OBJECT CONTROLLER: máquina de estados da mão
src/filters.js                 One Euro, histerese e debounce
src/ray-plane.js               tela 2D -> espaço 3D da AR
src/diagnostics.js             UI de diagnóstico + medidor de FPS
src/models.js                  MODEL LOADER: registro e dimensões reais
src/equipment.js               carregamento/normalização/descarte do GLB
models/equipamento.glb         modelo — SUBSTITUA por este arquivo pelo real
tools/make-panel-glb.mjs       gerador do quadro elétrico (modelo próprio)
tools/make-placeholder-glb.mjs gerador do cubo simples da V1
```

## Dependências

Apenas **Three.js r185**, carregado por CDN via `importmap` (módulo principal +
`GLTFLoader`). Nenhum build step, nenhum `npm install`, nenhuma outra biblioteca.

A versão r185 é requisito da oclusão: o suporte a Depth Sensing (`WebXRDepthSensing`,
`renderer.xr.hasDepthSensing()`) não existe no r160 usado na V1.

Para hospedar offline, baixe `three.module.js` e `examples/jsm/loaders/GLTFLoader.js`
e ajuste o `importmap` em `index.html`.

## Modelo 3D

O equipamento é um **quadro elétrico industrial de piso**, gerado
proceduralmente por `tools/make-panel-glb.mjs`: 11 materiais PBR, 2316
triângulos, 135 KB. Inclui gabinete, rodapé, porta com moldura, dobradiças,
maçaneta, duas grelhas de ventilação, três trilhos DIN com 36 disjuntores e
alavancas, barramentos de cobre, seis lâmpadas de sinalização, placa de
identificação e prensa-cabos.

| | |
|---|---|
| Nome | Quadro elétrico (procedural) |
| Fonte | Este repositório, `tools/make-panel-glb.mjs` |
| Licença | Mesma do projeto — **modelo próprio**, sem asset de terceiros |
| Formato original | glTF 2.0 binário (GLB), gerado direto em código |
| Dimensões reais | 0,80 × 2,00 × 0,47 m (a maçaneta projeta ~7 cm) |

Optei por gerar o modelo em vez de baixar um de terceiros justamente para não
deixar nenhuma dúvida de licença numa apresentação comercial.

## Substituir o modelo

Troque `models/equipamento.glb`. Requisitos do GLB:

- exportado **em metros** (convenção glTF) — a escala real é respeitada, não há
  normalização automática;
- eixo **Y para cima** e o objeto de pé na orientação desejada;
- o código centraliza em X/Z e apoia a base em `y = 0` automaticamente.

Para trocar ou acrescentar modelos, edite o registro em `src/models.js`. Adicionar um
equipamento é uma entrada no objeto `MODELS` mais o GLB em `/models` — não há catálogo
nem UI de seleção nesta versão, por decisão de escopo.

## Executar em HTTPS

O WebXR só funciona em contexto seguro (`https://` ou `localhost`).

**Opção A — cabo USB, sem certificado (recomendada para testar):**

```bash
python -m http.server 8080
```

Depois, com o celular conectado por USB e a depuração USB ativa, abra `chrome://inspect`
no Chrome do PC → *Port forwarding* → `8080` → `localhost:8080`. No celular, acesse
`http://localhost:8080`, que o Chrome trata como contexto seguro.

**Opção B — túnel HTTPS público:**

```bash
npx --yes serve -l 8080 .
```

```bash
npx --yes localtunnel --port 8080
```

Abra no celular a URL `https://…` gerada.

**Opção C — certificado local confiável** (`mkcert`) e qualquer servidor estático com
`-S/--ssl`, acessando pelo IP da máquina na rede local.

## Testar no Galaxy S20 FE + Chrome

1. Instale/atualize o **Google Play Services for AR (ARCore)** na Play Store.
2. Use o Chrome para Android atualizado (não Samsung Internet, não WebView de app).
3. Abra a URL HTTPS e toque em **Iniciar Realidade Aumentada**; conceda a permissão de câmera.
4. Aponte para o chão e mova o celular lateralmente por 2–3 s. O texto no topo orienta
   isso mesmo; ele muda sozinho para "Toque para posicionar" quando o app já considera a
   varredura suficiente — mas tocar antes disso também funciona, é só orientação, não
   trava nada. Se o aparelho conceder `plane-detection`, o contorno real da superfície
   mapeada aparece no chão em vez de só o retículo.
5. Toque na tela para posicionar o equipamento.
6. Caminhe ao redor: o objeto deve permanecer no mesmo ponto físico.
7. **Toque no objeto** para selecioná-lo — um anel discreto aparece na base.
8. Gestos (só com o objeto selecionado):
   - **1 dedo arrastando**: move sobre a superfície;
   - **2 dedos afastando/aproximando**: escala;
   - **2 dedos girando**: rotação no eixo vertical;
   - **2 dedos deslizando para cima/baixo**: altura.
   Cada gesto de dois dedos trava em UM modo por vez; solte os dedos para trocar.
   Um rótulo discreto no rodapé confirma qual modo está ativo.
9. Toque fora do objeto para desselecionar. **Reposicionar** recoloca. **Sair da AR** encerra.
10. **Vista explodida**: toque no botão para ver as peças do gabinete se separarem;
    **Remontar** volta tudo ao lugar. Funciona junto com escala/giro/altura normalmente.

Para testar a oclusão: com o objeto colocado, passe a mão entre o celular e o
equipamento. A mão deve cobrir a parte correspondente do objeto. O aviso no topo da
tela informa, nos primeiros segundos, se a oclusão por profundidade ficou ativa.

Se algo falhar, use `chrome://inspect` para ver o console do celular.

## Controle por mão

| Camada | Tecnologia | Quando entra |
|---|---|---|
| 1 | WebXR Hand Input (`XRHand`, joint poses) | headsets (Android XR, Quest) |
| 2 | MediaPipe Hand Landmarker + `camera-access` | Chrome Android com ARCore |
| 3 | Touchscreen | sempre disponível, e fallback final |

Gestos (com o objeto colocado, mão diante da câmera):

- **🤏 pinça sobre o equipamento** — seleciona e segura;
- **mover a mão na horizontal** — desloca sobre a superfície;
- **afastar/aproximar polegar e indicador** — escala;
- **girar a mão** — rotação no eixo vertical;
- **subir/descer a mão** — altura;
- **✋ abrir a mão** — solta; o objeto fica exatamente onde está.

Cada manipulação trava em **um** modo. Não basta o primeiro sinal cruzar seu
limiar — ele precisa vencer o segundo colocado por 45% de folga
(`DOMINANCE_MARGIN`, em [hand-controller.js](src/hand-controller.js) e
[gestures.js](src/gestures.js)). Sem essa margem, um gesto na diagonal (que
anda um pouco em X e em Y ao mesmo tempo) podia travar no modo errado só
porque um eixo cruzou o limiar um instante antes do outro — a mesma folga
existe para toque e para mão. Há também uma carência de 0,25 s após fechar a
pinça, durante a qual nada é classificado — sem ela, a própria convergência
dos filtros era lida como gesto de escala.

**Giro não funcionava.** O sinal vinha do vetor punho -> dedo médio, que
aponta na mesma direção do próprio giro do pulso — girar o pulso em torno do
antebraço quase não muda esse vetor, então o gesto não produzia sinal quase
nenhum. Trocado pelo vetor indicador -> mínimo (a linha dos nós dos dedos),
perpendicular ao antebraço: gira visivelmente na imagem quando o pulso gira,
como girar uma maçaneta. Confirmado com uma simulação numérica (um giro de
90° do pulso produzia 0,0 rad no sinal antigo e 1,57 rad — os 90° esperados
— no novo). **Testado no aparelho depois dessa troca e ainda não funcionava.**
Duas causas prováveis, corrigidas juntas: o filtro do sinal (`rollFilter` em
[hand-analyzer.js](src/hand/hand-analyzer.js)) herdou o `beta` baixo do sinal
antigo, que mal se movia — contra um giro rápido de verdade, esse beta
suavizava a maior parte do movimento antes de acumular; e `ROLL_THRESHOLD`
(~17°) supunha uma amplitude de giro que pinçar ao mesmo tempo (mão mais
restrita) dificulta alcançar — baixado para ~11°. Também adicionado
`ROLL Δ` no painel de diagnóstico: mostra em graus quanto o pulso já girou
desde que a pinça fechou, então uma próxima tentativa que falhar mostra o
número real em vez de exigir mais um palpite.

**Escala se confundindo com os outros gestos.** A razão polegar-indicador é
normalizada pelo tamanho da mão na imagem (distância punho->dedo médio) —
mas as duas são medidas 2D, e escorço (foreshortening) as altera quando a
mão gira ou inclina para MOVER, ALTURAR ou GIRAR, mesmo sem o usuário abrir
ou fechar os dedos de verdade. `RATIO_THRESHOLD` subiu de 0,18 para 0,26:
exige uma abertura/fechamento bem mais deliberado antes de travar em escala,
o que reduz o falso-positivo sem eliminar a causa — isso exigiria
profundidade 3D por landmark, que o MediaPipe 2D usado aqui não entrega.

**Reduzir a escala especificamente não funcionava.** Selecionar já exige a
pinça fechada (ratio < 0,42); apertar os dedos ainda mais para encolher é um
movimento pequeno e rápido, enquanto abrir para crescer é maior e mais lento.
Os dois sofriam o mesmo problema por um caminho diferente do de cima: durante
a carência de 0,25 s depois da pinça, `grab.ratio` é continuamente rebaseado
para o valor atual — necessário para não confundir a convergência do filtro
com um gesto real (ver acima), mas isso também apaga qualquer gesto genuíno
que termine dentro da janela. Um aperto rápido cabe inteiro em 250 ms; abrir
bem os dedos, raramente. `GRAB_SETTLE_SECONDS` caiu para 0,12 s, e o filtro
da razão (`ratio` em [hand-analyzer.js](src/hand/hand-analyzer.js)) ficou
menos rígido (beta 0,01 -> 0,04) para reagir mais rápido a um aperto de
verdade. Mesmo assim, um aperto MUITO rápido ainda pode caber dentro da
janela menor — por isso também ganhou `SCALE Δ` no painel, mesma lógica do
`ROLL Δ`: mostra a variação real da razão em %, positiva ao crescer e
negativa ao reduzir, para a próxima tentativa virar dado. Se `SCALE Δ` mal
sair do zero ao reduzir, o problema ainda é a janela/filtro; se passar de
-26% e nada encolher, o suspeito passa a ser o limite mínimo de escala
(`LIMITS.minScale = 0.2` em [gestures.js](src/gestures.js)) — o objeto pode
já estar no piso de 20% do tamanho original.

Qual modo está ativo aparece na tela — um rótulo discreto (`↔ Movendo`,
`⤢ Escala`, `⟳ Girando`, `↕ Altura`, `🤏 Selecionado`) que some sozinho quando
o gesto termina. Na primeira vez que a mão é detectada, uma legenda anima
cada ícone do jeito do próprio gesto (desliza, sobe/desce, gira, pulsa) e
explica o vocabulário completo; ela só aparece uma vez por aparelho (fica
marcada no `localStorage`). Ambos vivem em [gesture-hud.js](src/gesture-hud.js)
e nas classes `g-*` de [style.css](style.css).

O touchscreen tem prioridade: enquanto há um dedo na tela, o controle por mão
fica suspenso, para que os dois nunca escrevam no mesmo transform.

## Vista explodida

Botão **Vista explodida** no HUD (aparece depois de colocar o equipamento):
separa as peças do gabinete — porta, topo, laterais, fundo, as três fileiras
de disjuntores, barramentos, grelhas, lâmpadas/placa, prensa-cabos — com uma
transição suave de 0,6 s. **Remontar** volta tudo ao lugar. Reposicionar o
equipamento também remonta, para não deixar peças soltas para trás numa nova
colocação.

**Como funciona**: cada peça é um nó separado no GLB (não só um material —
ver [tools/make-panel-glb.mjs](tools/make-panel-glb.mjs)), com a direção e
distância da explosão gravadas em `node.extras`, que o GLTFLoader do
Three.js copia automaticamente para `object3D.userData.explode`.
[explode.js](src/explode.js) só lê esse dado — nenhum nome de peça
hardcoded fora do modelo. Um modelo sem peças marcadas simplesmente não tem
o que explodir, e o botão fica escondido (`onPlaced(explodable)` em
[ar-experience.js](src/ar-experience.js)); trocar de modelo no futuro não
exige tocar em nenhuma lógica aqui, só marcar as peças no gerador do GLB novo.

Duas peças (`Rodape`, `Vao` — o piso do gabinete e o vão interno escuro)
ficam de fora do mapa de explosão de propósito: servem de esqueleto fixo
para o resto se afastar, em vez de o gabinete inteiro flutuar sem
referência. As distâncias de cada peça estão no objeto `EXPLODE` no topo do
gerador — ajuste ali e rode `node tools/make-panel-glb.mjs` para regenerar.

Escala/gira/move funcionam igual com o gabinete explodido: esses gestos
mexem no grupo raiz do equipamento, as peças são filhas com posição local —
a vista explodida e a manipulação por mão/toque não competem pelo mesmo
transform.

## As duas camadas de oclusão

São mecanismos diferentes, e o painel mostra os dois separadamente.

| Camada | O que é | Cobre | Não cobre |
|---|---|---|---|
| `DEPTH` | Profundidade medida pelo ARCore | objetos e paredes **parados** | qualquer coisa em movimento |
| `HAND MASK` | Silhueta reconstruída dos 21 landmarks | a **mão** do usuário | pessoas, objetos |

**Por que a máscara existe.** O depth-from-motion do ARCore assume cena estática
e é preciso de 0,5 m a 5 m. Uma mão diante da câmera é objeto em movimento e
quase sempre mais perto que isso, então o mapa devolve a profundidade do fundo e
o equipamento é desenhado por cima. Ocluir atrás de objetos em movimento depende
de sensor **ToF**, que o Galaxy S20 FE não possui (a DepthVision existiu só no
S20+ e no S20 Ultra).

**O que a máscara é, honestamente.** Aproximação baseada em rastreamento, não
medição real. A distância vem do tamanho da mão na imagem combinado com a
projeção da câmera, então ela acompanha aproximar e afastar. Compõe com a
profundidade real usando `LessDepth`: só vence onde estiver de fato mais perto.
A silhueta é um hexágono por junta mais um retângulo por osso, não só
retângulos — sem isso a borda ficava visivelmente poligonal de perto.
Desligue com `?handmask=0` para comparar as duas.

**Ruído perto de bordas.** Captura de tela do aparelho mostrou o equipamento
"furado" na base — recorte serrilhado — sem mão nem objeto na frente, com
`DEPTH: ACTIVE CPU` isolado. O depth-from-motion ocasionalmente devolve um
texel isolado bem mais perto que toda a vizinhança, e isso bastava para
recortar o objeto e até quebrar o anel de seleção em arcos soltos (ele também
sofria o mesmo corte, por estar no chão bem onde o ruído aparecia). Duas
correções: `despeckle()` em [occlusion.js](src/occlusion.js) rejeita um texel
isolado que seja bem mais perto que os 4 vizinhos antes de escrevê-lo como
profundidade — tratado como "sem medida", igual a um buraco do sensor; e o
anel de seleção em [equipment.js](src/equipment.js) ganhou `depthTest: false`,
o mesmo tratamento que o retículo já tinha, por ser guia de UI e não algo
físico.

## Painel de diagnóstico

O botão **i** no HUD mostra/esconde AR, HIT TEST, HAND TRACKING (NATIVE /
MEDIAPIPE / OFF), DEPTH, DEPTH ORIENT, HAND MASK, CAM FRAME, INFERENCIAS, HAND,
PINCH, OBJECT, STATE e FPS.

O botão **D** liga a visualização das camadas de oclusão: o mapa de profundidade
sai como gradiente (vermelho = perto, verde = longe) e a silhueta da mão em
ciano. Cada toque avança uma das quatro convenções de orientação do mapa antes
de desligar — a escolhida continua valendo, e `?depthorient=N` a fixa. Ele diz qual camada
está realmente ativa — nenhum fallback é silencioso. Esconda-o para a
apresentação.

## Limitações do WebXR a observar

- **Contexto seguro obrigatório**: HTTPS ou `localhost`. Sem isso, `navigator.xr` nem existe.
- **Chrome Android apenas**: iOS/Safari não implementa `immersive-ar`; não há polyfill
  honesto. A POC exibe mensagem de incompatibilidade em vez de simular AR.
- **Dependência do ARCore**: sem o Google Play Services for AR instalado/atualizado, a
  sessão é recusada.
- **Qualidade do tracking**: superfícies lisas, sem textura, com pouca luz ou muito
  brilhantes degradam o hit-test. Movimento lento e lateral inicializa melhor o mapa.
- **Deriva**: sem `anchors`, o objeto pode derivar alguns centímetros ao caminhar. A POC
  cria uma `XRAnchor` quando disponível (é opcional no `requestSession`, com fallback
  para pose estática).
- **Um `hitTestSource` por sessão** e o `XRHitTestResult` só é válido no frame em que foi
  obtido — por isso a colocação é resolvida dentro do loop de render.
- **`dom-overlay`**: os gestos dependem dele (o canvas WebGL não recebe eventos de
  ponteiro em sessão imersiva). Sem overlay, apenas a colocação por `select` funciona.
- **Oclusão depende do Depth API do ARCore**: nem todo aparelho certificado expõe
  `depth-sensing`. Sem ele a experiência roda igual, apenas sem oclusão (fallback
  explícito em `src/occlusion.js`, sem simulação).
- **Qualidade do mapa de profundidade**: é de baixa resolução e ruidoso. Bordas de mão
  e cabelo ficam imprecisas, e superfícies muito próximas (< ~30 cm) ou muito distantes
  saem do alcance útil.
- **`gpu-optimized` é o único que o Three.js cobre nativamente**: para `cpu-optimized`
  o passe de `gl_FragDepth` é feito à mão em `CpuDepthOcclusion`
  ([occlusion.js](src/occlusion.js)) — é o caminho que o Galaxy S20 FE de fato concede.
- **Sem plane detection nem light estimation** nesta versão: o objeto não recebe a
  iluminação real do ambiente.
- **Hand Input nativo não existe em celular**: o ARCore não expõe esqueleto de mão
  ao WebXR. Num Galaxy S20 FE o caminho real é sempre o MediaPipe.
- **`getUserMedia` não serve durante a AR**: o ARCore é dono da câmera. Por isso o
  MediaPipe é alimentado pelo módulo Raw Camera Access (Chrome 107+).
- **Oclusão e profundidade por pixel são excludentes**: `depthUsage` é único por
  sessão. A oclusão exige `gpu-optimized`; ler profundidade no CPU exigiria
  `cpu-optimized`. Escolhemos a oclusão, e a posição 3D da mão vem de raycast.
- **MediaPipe custa banda e thread principal**: ~7 MB de modelo mais o WASM, baixados
  do CDN na primeira sessão. `detectForVideo` é síncrono e roda na mesma thread do loop
  WebXR — sem Web Worker, cada inferência trava um pouco o quadro seguinte. Captura de
  tela do aparelho mostrou 18–24 fps com AR + inferência + as duas oclusões ativas ao
  mesmo tempo. Reduzido para 8 Hz e 192 px de largura (eram 12 Hz / 256 px) para pesar
  menos a cada inferência; não verificado no aparelho se isso é suficiente — um Web
  Worker seria a correção definitiva, fora do escopo desta rodada.
- **Redimensionamento**: durante a sessão a projeção e o viewport são controlados pelo
  WebXR; o handler de resize só atua fora dela.
