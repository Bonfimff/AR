/**
 * Testes do modelo elétrico. Rodam sem celular, sem AR e sem dependências:
 *
 *   node tools/test-circuits.mjs
 *
 * Vale manter versionado (ao contrário dos testes de cena, que foram
 * descartáveis): é a única parte do sistema verificável fora do aparelho, e
 * é onde um erro silencioso seria perigoso — mostrar como desenergizado algo
 * que está vivo.
 */
import { CircuitModel } from "../src/circuits.js";

let passed = 0;
let failed = 0;

function check(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL ${description}\n       esperado ${JSON.stringify(expected)}, obtido ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`  ok   ${description}`);
}

function throws(description, fn) {
  try {
    fn();
    failed += 1;
    console.log(`  FAIL ${description} — não lançou`);
  } catch {
    passed += 1;
    console.log(`  ok   ${description}`);
  }
}

/** Quadro típico: entrada -> geral -> dois circuitos. */
function quadro() {
  return new CircuitModel()
    .add({ id: "entrada", kind: "source", label: "Alimentação" })
    .add({ id: "geral", kind: "breaker", label: "Disjuntor geral", feeds: [] })
    .add({ id: "disj-luz", kind: "breaker", label: "C1 Iluminação" })
    .add({ id: "disj-tom", kind: "breaker", label: "C2 Tomadas" })
    .add({ id: "int-sala", kind: "switch", label: "Interruptor sala" })
    .add({ id: "lamp-sala", kind: "lamp", label: "Lâmpada sala" })
    .add({ id: "tomada-1", kind: "outlet", label: "Tomada 1" })
    .connect("entrada", "geral")
    .connect("geral", "disj-luz")
    .connect("geral", "disj-tom")
    .connect("disj-luz", "int-sala")
    .connect("int-sala", "lamp-sala")
    .connect("disj-tom", "tomada-1");
}

console.log("\n[1] Estado inicial: tudo ligado");
{
  const c = quadro();
  c.solve();
  check("lâmpada acesa", c.isLive("lamp-sala"), true);
  check("tomada com energia", c.isLive("tomada-1"), true);
  check("geral energizado", c.isEnergized("geral"), true);
  check("sem problemas de montagem", c.validate(), []);
}

console.log("\n[2] Interruptor desliga só a lâmpada");
{
  const c = quadro();
  c.setClosed("int-sala", false);
  check("lâmpada apagada", c.isLive("lamp-sala"), false);
  check("tomada segue viva", c.isLive("tomada-1"), true);
  check("interruptor ainda recebe tensão", c.isEnergized("int-sala"), true);
  check("lâmpada não recebe mais tensão", c.isEnergized("lamp-sala"), false);
}

console.log("\n[3] Disjuntor do circuito desliga a lâmpada mesmo com interruptor ligado");
{
  const c = quadro();
  c.setClosed("disj-luz", false);
  check("interruptor está fechado", c.get("int-sala").closed, true);
  check("lâmpada apagada assim mesmo", c.isLive("lamp-sala"), false);
  check("interruptor sem tensão", c.isEnergized("int-sala"), false);
  check("tomada intacta", c.isLive("tomada-1"), true);
}

console.log("\n[4] Geral derruba tudo — e religa");
{
  const c = quadro();
  c.setClosed("geral", false);
  check("lâmpada apagada", c.isLive("lamp-sala"), false);
  check("tomada morta", c.isLive("tomada-1"), false);
  check("disjuntor de luz sem tensão", c.isEnergized("disj-luz"), false);
  // A distinção que importa para quem vai mexer no quadro: o disjuntor geral
  // DESLIGADO continua energizado do lado da entrada.
  check("geral desligado ainda recebe tensão", c.isEnergized("geral"), true);
  check("geral não está 'live'", c.isLive("geral"), false);

  c.setClosed("geral", true);
  check("religou a lâmpada", c.isLive("lamp-sala"), true);
  check("religou a tomada", c.isLive("tomada-1"), true);
}

console.log("\n[5] Interruptor paralelo (three-way): ciclo na topologia não trava");
{
  const c = new CircuitModel()
    .add({ id: "src", kind: "source" })
    .add({ id: "a", kind: "switch" })
    .add({ id: "b", kind: "switch" })
    .add({ id: "luz", kind: "lamp" })
    .connect("src", "a")
    .connect("src", "b")
    .connect("a", "luz")
    .connect("b", "luz")
    // Ciclo deliberado: os dois se alimentam mutuamente.
    .connect("a", "b")
    .connect("b", "a");

  c.solve(); // se houvesse laço infinito, o teste não chegaria à linha seguinte
  check("acesa com os dois fechados", c.isLive("luz"), true);
  c.setClosed("a", false);
  check("um caminho aberto: segue acesa pelo outro", c.isLive("luz"), true);
  c.setClosed("b", false);
  check("os dois abertos: apaga", c.isLive("luz"), false);
}

console.log("\n[6] downstreamOf: o que este disjuntor controla");
{
  const c = quadro();
  check(
    "disj-luz controla interruptor e lâmpada",
    [...c.downstreamOf("disj-luz")].sort(),
    ["int-sala", "lamp-sala"]
  );
  check(
    "geral controla o resto do quadro",
    [...c.downstreamOf("geral")].sort(),
    ["disj-luz", "disj-tom", "int-sala", "lamp-sala", "tomada-1"]
  );
}

console.log("\n[7] Validação de plantas incompletas");
{
  const solto = new CircuitModel()
    .add({ id: "src", kind: "source" })
    .add({ id: "orfa", kind: "lamp" });
  check("acusa elemento sem alimentação", solto.validate(), [
    { id: "orfa", problem: "sem-alimentacao" },
  ]);

  const semFonte = new CircuitModel().add({ id: "luz", kind: "lamp" });
  check(
    "acusa ausência de fonte",
    semFonte.validate().map((p) => p.problem).sort(),
    ["sem-alimentacao", "sem-fonte"]
  );

  // Desligar não é o mesmo que estar desconectado: validate() olha topologia.
  const desligado = quadro();
  desligado.setClosed("geral", false);
  check("disjuntor desligado não é 'sem-alimentacao'", desligado.validate(), []);
}

console.log("\n[8] Erros de programação são ruidosos, não silenciosos");
{
  const c = quadro();
  throws("manobrar uma lâmpada lança", () => c.setClosed("lamp-sala", false));
  throws("id inexistente lança", () => c.setClosed("nao-existe", false));
  throws("tipo desconhecido lança", () => c.add({ id: "x", kind: "reator" }));
  throws("id duplicado lança", () => c.add({ id: "geral", kind: "breaker" }));
}

console.log("\n[9] onChange dispara só quando a energização muda de fato");
{
  const c = quadro();
  c.solve();
  let calls = 0;
  c.onChange = () => { calls += 1; };

  c.setClosed("int-sala", false);
  check("desligar avisou uma vez", calls, 1);

  c.setClosed("int-sala", false); // já está aberto
  check("redundância não avisa", calls, 1);

  // Manobra sem consequência: nada abaixo dele muda de estado.
  c.setClosed("disj-luz", false);
  check("disj-luz corta o interruptor: avisa", calls, 2);
}

console.log("\n[10] Ida e volta pelo JSON (base do arquivo salvo)");
{
  const c = quadro();
  c.setClosed("int-sala", false);
  c.setClosed("disj-tom", false);

  const round = CircuitModel.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  check("mesma quantidade de elementos", round.elements.size, c.elements.size);
  check("estado de manobra preservado", round.get("int-sala").closed, false);
  check("lâmpada continua apagada", round.isLive("lamp-sala"), false);
  check("tomada continua morta", round.isLive("tomada-1"), false);
  check("geral continua vivo", round.isLive("geral"), true);
  check("rótulos preservados", round.get("disj-luz").label, "C1 Iluminação");
  throws("versão desconhecida é recusada", () =>
    CircuitModel.fromJSON({ version: 99, elements: [] })
  );
}

console.log(`\n${passed} passaram, ${failed} falharam\n`);
process.exit(failed ? 1 : 0);
