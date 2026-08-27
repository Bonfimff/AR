# Modo AR — Prova de Conceito WebXR

POC de realidade aumentada com rastreamento espacial: WebXR `immersive-ar` + hit-test +
âncora espacial, renderizado com Three.js. Um único objeto 3D, sem backend, sem banco,
sem login.

## Estrutura

```
index.html                     interface + importmap do Three.js
style.css                      estilos (tela inicial e HUD da AR)
app.js                         bootstrap, verificação de suporte, ligação da UI
src/ar-experience.js           sessão WebXR, hit-test, âncora, seleção, loop de render
src/gestures.js                gestos de toque (arrastar, pinça, giro, altura)
src/occlusion.js               oclusão por profundidade (WebXR Depth Sensing)
src/models.js                  registro de modelos (preparado para expansão)
src/equipment.js               carregamento/normalização/descarte do GLB
models/equipamento.glb         modelo — SUBSTITUA por este arquivo pelo real
tools/make-placeholder-glb.mjs gerador do GLB de marcação (só para a POC)
```

## Dependências

Apenas **Three.js r185**, carregado por CDN via `importmap` (módulo principal +
`GLTFLoader`). Nenhum build step, nenhum `npm install`, nenhuma outra biblioteca.

A versão r185 é requisito da oclusão: o suporte a Depth Sensing (`WebXRDepthSensing`,
`renderer.xr.hasDepthSensing()`) não existe no r160 usado na V1.

Para hospedar offline, baixe `three.module.js` e `examples/jsm/loaders/GLTFLoader.js`
e ajuste o `importmap` em `index.html`.

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
- **Redimensionamento**: durante a sessão a projeção e o viewport são controlados pelo
  WebXR; o handler de resize só atua fora dela.
