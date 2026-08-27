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
src/occlusion.js               oclusão por profundidade (WebXR Depth Sensing)
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
4. Aponte para o chão e mova o celular lateralmente por 2–3 s até o retículo verde aparecer.
5. Toque na tela para posicionar o equipamento.
6. Caminhe ao redor: o objeto deve permanecer no mesmo ponto físico.
7. **Toque no objeto** para selecioná-lo — um anel discreto aparece na base.
8. Gestos (só com o objeto selecionado):
   - **1 dedo arrastando**: move sobre a superfície;
   - **2 dedos afastando/aproximando**: escala;
   - **2 dedos girando**: rotação no eixo vertical;
   - **2 dedos deslizando para cima/baixo**: altura.
   Cada gesto de dois dedos trava em UM modo por vez; solte os dedos para trocar.
9. Toque fora do objeto para desselecionar. **Reposicionar** recoloca. **Sair da AR** encerra.

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

Cada manipulação trava em **um** modo, escolhido pelo primeiro sinal que cruza
seu limiar. É o que impede escala e rotação involuntárias quando a mão faz
várias coisas ao mesmo tempo. Há uma carência de 0,25 s após fechar a pinça,
durante a qual nada é classificado — sem ela, a própria convergência dos
filtros era lida como gesto de escala.

O touchscreen tem prioridade: enquanto há um dedo na tela, o controle por mão
fica suspenso, para que os dois nunca escrevam no mesmo transform.

## Painel de diagnóstico

O botão **i** no HUD mostra/esconde AR, HIT TEST, HAND TRACKING (NATIVE /
MEDIAPIPE / OFF), DEPTH, HAND, PINCH, OBJECT, STATE e FPS. Ele diz qual camada
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
- **Só o modo `gpu-optimized`**: é o único que o renderer usa para escrever `gl_FragDepth`.
  Pedir `cpu-optimized` habilitaria a feature sem produzir oclusão nenhuma.
- **Sem plane detection nem light estimation** nesta versão: o objeto não recebe a
  iluminação real do ambiente.
- **Hand Input nativo não existe em celular**: o ARCore não expõe esqueleto de mão
  ao WebXR. Num Galaxy S20 FE o caminho real é sempre o MediaPipe.
- **`getUserMedia` não serve durante a AR**: o ARCore é dono da câmera. Por isso o
  MediaPipe é alimentado pelo módulo Raw Camera Access (Chrome 107+).
- **Oclusão e profundidade por pixel são excludentes**: `depthUsage` é único por
  sessão. A oclusão exige `gpu-optimized`; ler profundidade no CPU exigiria
  `cpu-optimized`. Escolhemos a oclusão, e a posição 3D da mão vem de raycast.
- **MediaPipe custa banda e GPU**: ~7 MB de modelo mais o WASM, baixados do CDN na
  primeira sessão. A inferência roda a 12 Hz e em 256 px de largura de propósito.
- **Redimensionamento**: durante a sessão a projeção e o viewport são controlados pelo
  WebXR; o handler de resize só atua fora dela.
