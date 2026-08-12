import { Agent } from "agents";
import { streamText } from "ai";
import type { SystemModelMessage } from "ai";
import type { Env } from "./env";
import { Db } from "./db/client";
import { ConversationsRepo } from "./db/conversations";
import { MessagesRepo } from "./db/messages";
import { isPro } from "./config";
import { resolveAgentConfig } from "./settings-loader";
import { buildTools } from "./tools";
import { buildMultimodalUserMessage } from "./media/vision";
import { chunkReply } from "./replies/chunker";
import { pickAdapter } from "./replies/sender";
import { selectModel } from "./upgrade/modelSelector";
import type { Tier } from "./upgrade/modelSelector";
import { monthIaCostUsd, applyBudgetGuard } from "./budget";
import { CustomerFactsRepo } from "./db/facts";
import { createModel } from "./llm/provider";
import { costOfUsage } from "./pricing";
import { renderInteractiveAsText, type ChannelId } from "./channels/shared";

export interface SupportAgentState {
  conversationId: string | null;
  channel: string;
  channelUserId: string;
  pendingMessages: { text: string; receivedAt: number }[];
  lastAlarmAt: number;
  lastUserLang: string;
  toolCallsInLast2Turns: number;
  lastSearchKbScore: number;
  imageRetryCount: number;
}

export interface AgentIncomingPayload {
  channel: string;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  /** Tap de botón/lista (askWithOptions) en vez de texto tipeado — ver
   * IncomingMessage en channels/shared.ts. El guard anti-spam de repetición
   * lo saltea (Hallazgo 1: 3+ taps idénticos no deben silenciar al bot). */
  isInteractiveReply?: boolean;
}

export class SupportAgent extends Agent<Env, SupportAgentState> {
  initialState: SupportAgentState = {
    conversationId: null,
    channel: "",
    channelUserId: "",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
  };

  /**
   * Called by the Worker fetch handler when a webhook arrives for this user.
   * Buffers the message, schedules/resets an alarm.
   */
  async ingest(payload: AgentIncomingPayload): Promise<{ acknowledged: true }> {
    const db = new Db(this.env.DB);
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate(
      payload.channel,
      payload.channelUserId,
      payload.displayName,
    );
    this.setState({
      ...this.state,
      channel: payload.channel,
      channelUserId: payload.channelUserId,
      conversationId: conv.id,
    });

    // Owner intervened → pause the bot, do NOT process this as user input
    if (payload.isOwnerMessage) {
      const pausedUntil = Date.now() + 60 * 60 * 1000;
      await convs.setPausedUntil(conv.id, pausedUntil);
      return { acknowledged: true };
    }

    // If paused, ignore (bot stays silent)
    if (await convs.isPaused(conv.id)) {
      return { acknowledged: true };
    }

    // Guardrail anti-spam: el mismo mensaje por 3ª vez entre los últimos 5 →
    // la conversación descansa 1 hora, sin respuesta y sin gastar LLM.
    if (payload.text && !payload.audioUrl && !payload.imageUrl) {
      try {
        const { isRepeatSpam, SPAM_SNOOZE_MS, isOverDailyCap, DAILY_CAP_SNOOZE_MS, DAILY_CAP_MESSAGE } =
          await import("./spam");
        // Un tap de botón/lista (askWithOptions) repite SIEMPRE el mismo
        // texto — a diferencia de texto libre tipeado, que varía natural
        // ("si"/"sí"/"dale"/"claro"). Sin este saltee, un triage de varias
        // preguntas respondido a tacos dispara el guard de repetición y
        // silencia al bot 1h: justo el escenario que askWithOptions existe
        // para resolver. Solo se saltea ESTE chequeo — el tope diario de
        // abajo sigue aplicando igual.
        if (!payload.isInteractiveReply && (await isRepeatSpam(db, conv.id, payload.text))) {
          await convs.setPausedUntil(conv.id, Date.now() + SPAM_SNOOZE_MS);
          console.warn(`[spam-guard] conv ${conv.id} en cooldown 1h (mensaje repetido)`);
          return { acknowledged: true };
        }
        // Tope diario de turnos: despedida amable UNA vez + descanso 12h. La
        // pausa garantiza que no se repita (los siguientes mensajes mueren en
        // isPaused antes de llegar aquí).
        if (await isOverDailyCap(db, conv.id)) {
          await convs.setPausedUntil(conv.id, Date.now() + DAILY_CAP_SNOOZE_MS);
          await new MessagesRepo(db).append(conv.id, "assistant", DAILY_CAP_MESSAGE);
          const channel = payload.channel as ChannelId;
          await pickAdapter(channel).sendReply(
            { channel, channelUserId: payload.channelUserId, chunks: [DAILY_CAP_MESSAGE] },
            this.env,
          );
          console.warn(`[spam-guard] conv ${conv.id} tope diario de turnos → descanso 12h`);
          return { acknowledged: true };
        }
      } catch (e) {
        // El guard es un extra, nunca la ruta crítica: si falla, se responde normal.
        console.warn("[spam-guard] check failed:", e);
      }
    }

    // Process media (audio → transcription, image → Pro-gated multimodal marker)
    let processedText = payload.text ?? "";
    let hasImage = false;

    if (payload.audioUrl) {
      try {
        const { transcribeAudio } = await import("./media/transcribe");
        const result = await transcribeAudio(payload.audioUrl, this.env);
        processedText = result.text || "(audio sin transcripción)";
      } catch (e) {
        console.error("[ingest] transcription failed:", e);
        processedText = "(no pude entender el audio)";
      }
    }

    if (payload.imageUrl) {
      hasImage = true;
      // Pro-only: if free tier, strip the image and inform the bot owner-side
      if (!isPro(this.env)) {
        processedText =
          (processedText || "") +
          "\n(El cliente mandó una imagen, pero tu plan no soporta análisis de imágenes.)";
      } else {
        processedText =
          (processedText || "(imagen sin caption)") +
          `\n[IMAGE_URL: ${payload.imageUrl}]`;
      }
    }

    // Append to buffer (we always persist the client's message)
    const pending = [
      ...this.state.pendingMessages,
      { text: processedText, receivedAt: Date.now() },
    ];
    this.setState({
      ...this.state,
      pendingMessages: pending,
      imageRetryCount: hasImage ? 0 : this.state.imageRetryCount,
    });

    // Resolve effective config (D1 settings overlaid on env defaults).
    // We need at least bot_paused (to decide whether to reply) and the buffer.
    const cfg = await resolveAgentConfig(this.env, []);

    // Owner paused the bot via the dashboard → keep the message buffered but
    // stay silent: do NOT arm the alarm, so alarm() never runs.
    if (cfg.botPaused) {
      return { acknowledged: true };
    }

    // Schedule buffer processing via the agents SDK scheduler.
    // The SDK overrides alarm() to dispatch named callbacks from its
    // cf_agents_schedules table, so raw ctx.storage.setAlarm() alone won't
    // invoke our code. We upsert a fixed 'msg-buffer' row (so rapid messages
    // debounce to a single fire) and set the raw alarm as the trigger.
    const alarmAt = Date.now() + cfg.bufferMs;
    const alarmAtSec = Math.floor(alarmAt / 1000);
    this.sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, time, created_at)
      VALUES
        ('msg-buffer', 'processBuffer', '{}', 'delayed', ${alarmAtSec}, unixepoch())
    `;
    await this.ctx.storage.setAlarm(alarmAt);
    this.setState({ ...this.state, lastAlarmAt: alarmAt });

    return { acknowledged: true };
  }

  /**
   * Called by the agents SDK scheduler when the msg-buffer task fires.
   * Processes accumulated messages as one input, runs the LLM loop, and
   * sends the chunked reply over the channel adapter.
   */
  async processBuffer(): Promise<void> {
    const buffered = [...this.state.pendingMessages];
    this.setState({ ...this.state, pendingMessages: [] });
    if (buffered.length === 0) return;

    const combined = buffered.map((m) => m.text).join("\n").trim();
    if (!combined) return;

    const db = new Db(this.env.DB);
    const msgs = new MessagesRepo(db);
    const convs = new ConversationsRepo(db);
    const convId = this.state.conversationId;
    if (!convId) {
      console.warn("[SupportAgent.processBuffer] no conversation_id in state");
      return;
    }

    // Persist user message
    await msgs.append(convId, "user", combined);
    await convs.touchLastMessage(convId);

    // Load history (last 20)
    const history = await msgs.lastN(convId, 20);
    const aiMessages: any[] = history.slice(0, -1).map((m) => ({
      role: (m.role === "tool"
        ? "user"
        : m.role === "owner"
          ? "assistant"
          : m.role) as "user" | "assistant",
      content: m.content,
    }));
    // Build the LAST user message multimodal-aware: if it carries an
    // [IMAGE_URL: ...] marker AND we're on the Pro tier, attach the image.
    const lastUserMsg = history[history.length - 1];
    if (lastUserMsg) {
      const imgMatch = lastUserMsg.content.match(/\[IMAGE_URL: (.+?)\]/);
      if (imgMatch && isPro(this.env)) {
        const imageUrl = imgMatch[1];
        const cleanText = lastUserMsg.content
          .replace(/\n?\[IMAGE_URL: .+?\]/, "")
          .trim();
        aiMessages.push(buildMultimodalUserMessage(cleanText, imageUrl));
      } else {
        aiMessages.push({ role: "user", content: lastUserMsg.content });
      }
    }

    // Build tools registry (tier-gated in buildTools)
    const tools = buildTools({
      env: this.env,
      getConversationId: () => convId,
    });
    const toolNames = Object.keys(tools);

    // Resolve effective config (D1 settings overlaid on env defaults).
    const cfg = await resolveAgentConfig(this.env, toolNames);

    // Honor the dashboard's tool toggles: the prompt already only advertises
    // enabled tools (settings-loader), so the registry must match.
    const enabledTools = Object.fromEntries(
      Object.entries(tools).filter(([name]) => cfg.enabledToolNames.includes(name)),
    );

    // Select tier: honor an explicit override, otherwise auto-select. The active
    // provider (Anthropic default | OpenAI) maps the tier to a concrete model id.
    let tier: Tier =
      cfg.modelOverride === "haiku"
        ? "fast"
        : cfg.modelOverride === "sonnet"
          ? "smart"
          : selectModel({
              toolCallsInLast2Turns: this.state.toolCallsInLast2Turns,
              lastUserText: combined,
              lastUserLang: this.env.BOT_LANGUAGE,
              hasImage: false,
              imageRetryCount: this.state.imageRetryCount,
              lastSearchKbScore: this.state.lastSearchKbScore,
            });

    // Budget guard: at/over the monthly AI budget the bot keeps answering but
    // only on the cheap tier (never goes silent over money).
    if (cfg.monthlyBudgetUsd !== undefined && tier !== "fast") {
      const spent = await monthIaCostUsd(db);
      const guard = applyBudgetGuard(tier, spent, cfg.monthlyBudgetUsd);
      if (guard.downgraded) {
        console.warn(
          `[SupportAgent] monthly budget reached ($${spent.toFixed(2)}/$${cfg.monthlyBudgetUsd}) — downgrading to fast tier`,
        );
      }
      tier = guard.tier;
    }

    const { model, modelId, supportsPromptCache } = createModel(this.env, tier, cfg.llm);

    // Cache the (large, stable) system prompt with an ephemeral cache breakpoint.
    // Only the system block is cached — messages change every turn. Cache hits
    // show up in usage.cachedInputTokens (read below for cost accounting).
    // Prompt caching is Anthropic-only; on OpenAI we send the plain system block.
    const system: SystemModelMessage[] = [
      {
        role: "system",
        content: cfg.systemPrompt,
        ...(supportsPromptCache
          ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
          : {}),
      },
    ];

    // Customer memory (flywheel): facts extracted by the insights analyzer are
    // injected as a small UNCACHED system block, so a returning customer is
    // greeted by a bot that remembers them. The big prompt above stays cached.
    // Memory is an enhancement, never the critical path: if the lookup fails,
    // the reply still goes out.
    try {
      const facts = await new CustomerFactsRepo(db).forConversation(convId, 8);
      if (facts.length > 0) {
        system.push({
          role: "system",
          content: `<cliente>\nLo que ya sabes de este cliente (de conversaciones pasadas):\n${facts
            .map((f) => `- ${f.fact}`)
            .join("\n")}\n</cliente>`,
        });
      }
    } catch (e) {
      console.warn("[SupportAgent] customer facts lookup failed:", e);
    }

    let assistantText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let toolCallCount = 0;
    let toolCallsMade: { toolName: string; input: unknown }[] = [];
    let usedModelId = modelId;

    // Corre el loop del LLM con un modelo dado; deja los resultados en las vars.
    const attempt = async (m: any) => {
      const result = streamText({
        model: m,
        system,
        messages: aiMessages,
        tools: enabledTools,
        stopWhen: ({ steps }) => steps.length >= 6,
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      });
      let text = "";
      for await (const chunk of result.textStream) {
        text += chunk;
      }
      assistantText = text;
      const usage = await result.usage;
      inputTokens = usage?.inputTokens ?? 0;
      outputTokens = usage?.outputTokens ?? 0;
      cachedTokens = usage?.cachedInputTokens ?? 0;
      const steps = await result.steps;
      toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
      // Persist what the agent DID (not just what it said): tool name + input,
      // feeding the dashboard's thread chips, stats and the Mi Agente counters.
      toolCallsMade = steps.flatMap((s) =>
        (s.toolCalls ?? []).map((tc: any) => ({
          toolName: tc.toolName as string,
          input: tc.input,
        })),
      );
    };

    try {
      await attempt(model);
    } catch (e: any) {
      // FAILOVER con backoff: en ráfagas (historias) el primario suele dar un
      // rate-limit TRANSITORIO — esperar con jitter y reintentar resuelve la
      // mayoría; si no, se prueba el proveedor alterno (también con un segundo
      // intento). El jitter des-sincroniza mensajes que llegaron en el mismo
      // segundo. El bot no puede quedarse mudo el día del evento.
      console.error("[SupportAgent.processBuffer] streamText failed:", e);
      const backoff = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const { fallbackModel } = await import("./llm/provider");
      const primary = createModel(this.env, tier, cfg.llm);
      const fb = fallbackModel(this.env, tier, primary.provider);
      let ok = false;

      await backoff(2000 + Math.floor(Math.random() * 1500));
      try {
        await attempt(model);
        ok = true;
      } catch (e1: any) {
        console.error("[SupportAgent.processBuffer] primary retry failed:", e1);
      }

      if (!ok && fb) {
        console.warn(
          `[SupportAgent] failover ${primary.provider} → ${fb.provider}/${fb.modelId}`,
        );
        try {
          await attempt(fb.model);
          usedModelId = fb.modelId;
          ok = true;
        } catch (e2: any) {
          console.error("[SupportAgent.processBuffer] fallback failed:", e2);
          await backoff(2500 + Math.floor(Math.random() * 1500));
          try {
            await attempt(fb.model);
            usedModelId = fb.modelId;
            ok = true;
          } catch (e3: any) {
            console.error("[SupportAgent.processBuffer] fallback retry failed:", e3);
          }
        }
      }

      if (!ok) {
        assistantText = "Algo falló de mi lado, intenta de nuevo en un momento.";
      }
    }

    // Si el modelo llamó askWithOptions, esa llamada arma el interactive
    // (botones/lista nativos o texto numerado, según el canal). Calculado
    // ANTES del persist de abajo: <opciones_multiples> le pide al modelo no
    // repetir la pregunta como texto, así que `assistantText` suele venir vacío en
    // estos turnos — persistir ese vacío rompería el turno siguiente
    // (Anthropic rechaza un content block de texto vacío en el historial).
    // findLast() needs ES2023 lib (this project targets ES2022) — filter+pop
    // gets the same "last matching call wins" semantics.
    const askCall = toolCallsMade.filter((c) => c.toolName === "askWithOptions").pop();
    const askPregunta = askCall
      ? (askCall.input as { pregunta: string; opciones: string[] }).pregunta
      : undefined;
    const interactiveText = askCall
      ? renderInteractiveAsText({
          question: askPregunta!,
          options: (askCall.input as { pregunta: string; opciones: string[] }).opciones,
        })
      : undefined;
    // Hallazgo 3 (revisión final): si el modelo respondió algo sustantivo
    // ANTES de ofrecer el follow-up ("El control cuesta $30.000." + luego
    // askWithOptions("¿Agendamos?", ...)), ese texto ya NO se descarta —
    // decisión del dueño: se manda como mensaje real y se persiste junto con
    // la pregunta, así D1 queda como un registro fiel de todo lo que recibió
    // el cliente en el turno. Cuando `assistantText` viene vacío (el caso
    // común, porque <opciones_multiples> le pide al modelo no repetir la pregunta),
    // el comportamiento es el de siempre: solo el interactive.
    //
    // Red de seguridad de código (2026-08-09, endurecida 2026-08-12): tres
    // vueltas de wording más fuerte en <opciones_multiples> y en la
    // description de la tool NO eliminaron que el modelo, en vivo, a veces
    // escriba la pregunta como texto Y ADEMÁS la mande vía askWithOptions.
    // Un "preferí"/"SIEMPRE" en el prompt es una instrucción, no una
    // garantía; acá se verifica en código.
    //
    // La normalización quita tildes (NFD + strip de marcas combinantes) y
    // puntuación de apertura/cierre en español (¿...?, ¡...!) — cubre que el
    // modelo escriba "¿Cual es tu prevision?" (sin tildes, texto libre) contra
    // una `pregunta` estructurada "¿Cuál es tu previsión?" (con tildes).
    const normalizeForDupeCheck = (s: string) =>
      s
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // marcas combinantes (tildes) tras NFD
        .replace(/^[¿¡]+|[?!.,;:]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    // 2026-08-12, prueba en vivo (WhatsApp, captura real): el guardrail de
    // "todo el texto ES la pregunta" no atrapaba el caso real — el modelo
    // escribió contenido sustantivo real (info de la primera consulta) Y
    // ADEMÁS la pregunta repetida DOS VECES seguidas, cada una en su propio
    // párrafo: "Excelente. [...] dura 45 minutos.\n\n¿Con cuál previsión
    // estás afiliado?\n\n¿Con cuál previsión estás afiliado?" — el cliente
    // vio la pregunta duplicada en dos burbujas de WhatsApp antes de los
    // botones. En vez de comparar el texto ENTERO contra la pregunta, se
    // separa por párrafo/línea/antes-de-"¿" y se recorta del final cualquier
    // trozo que normalice igual a la pregunta — las veces que haga falta
    // (tope 5, por si el modelo la repite más de dos veces). El texto
    // sustantivo real (Hallazgo 3) nunca termina normalizando igual a la
    // pregunta, así que nunca se recorta por error.
    const stripTrailingQuestionRestatements = (text: string, question: string): string => {
      const normQuestion = normalizeForDupeCheck(question);
      if (!normQuestion) return text;
      let current = text;
      for (let i = 0; i < 5; i++) {
        // Caso base: el texto RESTANTE es, en sí mismo, la pregunta — sin
        // nada antes que separar (ej. la primera vez que se llama, cuando
        // `assistantText` es solo la pregunta y nada más). Ningún splitter de
        // abajo produce 2+ partes en ese caso porque no hay nada previo.
        if (normalizeForDupeCheck(current) === normQuestion) {
          current = "";
          break;
        }
        let strippedThisRound = false;
        for (const splitter of [/\n\n+/, /\n+/, /(?=¿)/]) {
          const parts = current
            .split(splitter)
            .map((p) => p.trim())
            .filter(Boolean);
          if (parts.length < 2) continue;
          const last = parts[parts.length - 1];
          if (normalizeForDupeCheck(last) === normQuestion) {
            current = parts.slice(0, -1).join("\n\n").trim();
            strippedThisRound = true;
            break;
          }
        }
        if (!strippedThisRound) break;
      }
      return current;
    };
    const cleanedAssistantText =
      askPregunta !== undefined
        ? stripTrailingQuestionRestatements(assistantText, askPregunta)
        : assistantText;
    // LÍMITE CONOCIDO, no cubierto a propósito: solo recorta cuando un trozo
    // COMPLETO (párrafo/línea/frase) normaliza igual a la pregunta, no
    // near-duplicates con relleno DENTRO de la misma frase ("Dime, ¿cuál es
    // tu previsión?" sin salto de línea/frase antes) — ver el test "documenta
    // el límite" en agent.test.ts. Ampliar esto a fuzzy-matching arriesga
    // falsos positivos sobre texto sustantivo real; si vuelve a aparecer en
    // vivo con otra forma, mejor medir con logs antes de ampliar a ciegas.
    const hasRealText = cleanedAssistantText.trim().length > 0;
    const persistedText = askCall
      ? hasRealText
        ? `${cleanedAssistantText}\n\n${interactiveText}`
        : interactiveText!
      : assistantText;

    // Persist assistant message (with usage + model_used + tool calls)
    await msgs.append(convId, "assistant", persistedText, {
      modelUsed: usedModelId,
      inputTokens,
      outputTokens,
      cachedInputTokens: cachedTokens,
      toolCalls: toolCallsMade.length > 0 ? toolCallsMade : undefined,
    });

    // Update state for next turn
    this.setState({
      ...this.state,
      toolCallsInLast2Turns: toolCallCount,
    });

    // Chunk + send via the channel adapter.
    const channel = this.state.channel as ChannelId;
    const adapter = pickAdapter(channel);
    let sentSummary: string;
    if (askCall) {
      const { pregunta, opciones } = askCall.input as { pregunta: string; opciones: string[] };
      let chunks: string[] = [];
      // Hallazgo 3: texto sustantivo antes del follow-up se manda como
      // mensaje real PRIMERO, y el interactive DESPUÉS, en una segunda
      // llamada — nada se descarta. No hay precedente en el codebase de un
      // delay artificial ENTRE dos sendReply() distintos (interChunkDelayMs
      // solo pacea chunks dentro de una misma llamada), así que no se
      // inventa uno acá.
      if (hasRealText) {
        chunks = chunkReply(cleanedAssistantText, cfg.maxChunks);
        await adapter.sendReply(
          {
            channel,
            channelUserId: this.state.channelUserId,
            chunks,
            interChunkDelayMs: cfg.interChunkDelayMs,
          },
          this.env,
        );
      }
      await adapter.sendReply(
        {
          channel,
          channelUserId: this.state.channelUserId,
          chunks: [],
          interactive: { question: pregunta, options: opciones },
        },
        this.env,
      );
      sentSummary = hasRealText
        ? `${chunks.length} chunks + 1 interactive prompt`
        : "1 interactive prompt";
    } else {
      const chunks = chunkReply(assistantText, cfg.maxChunks);
      await adapter.sendReply(
        {
          channel,
          channelUserId: this.state.channelUserId,
          chunks,
          interChunkDelayMs: cfg.interChunkDelayMs,
        },
        this.env,
      );
      sentSummary = `${chunks.length} chunks`;
    }

    console.log(
      `[SupportAgent.processBuffer] sent ${sentSummary}, model=${usedModelId}, cost=$${costOfUsage(
        usedModelId,
        { input: inputTokens, cached: cachedTokens, output: outputTokens },
      ).toFixed(5)}`,
    );
  }
}
