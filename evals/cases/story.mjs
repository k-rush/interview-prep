import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Evaluate the actual reply, not the application's appended filing receipt or source list.
function prose(detail, mode) {
  const last = detail.messages.at(-1);
  assert.equal(last.speaker, 'assistant');
  assert.equal(last.mode, mode, 'A guided fallback is not a model answer');
  return last.text.split(/\n\n(?:Workspace sources:|Added your wording to Job experience|Linked this answer to your existing statement|That wording was already reviewed\.)/u)[0].trim();
}

function check(text, { need = [], avoid = [], maxWords, direct } = {}) {
  for (const meaning of need) assert.match(text, meaning, `Missing narrative element: ${meaning}`);
  for (const invention of avoid) assert.doesNotMatch(text, invention, `Unsupported narrative element: ${invention}`);
  if (maxWords) assert.ok(text.split(/\s+/u).length <= maxWords, 'Too long to say aloud in the requested time');
  if (direct) assert.doesNotMatch(text, /\?/, 'A requested spoken line should not end in a coaching exercise');
  assert.doesNotMatch(text, /\bI(?:'ve|’ve| have|'ll|’ll| will)?\s+(?:save(?:d)?|confirm(?:ed)?|approve(?:d)?|book(?:ed)?)\s+(?:this|that|your)\s+(?:story|claim|session|application|draft|appointment)\b/i);
}

function fromThread(packet, ...claims) {
  for (const claim of claims)
    assert.ok(packet.examples.some(e => e.claim === claim && e.confirmed === false), 'Expected the current, unreviewed candidate statement');
}

async function coach(c, id, message, reply, rules = {}, inspect = () => {}) {
  c.expect('chat.coach', { turn: { reply, kind: 'none', label: '' } }, p => {
    assert.equal(p.message, message);
    assert.ok(p.search_workspace.length <= 5 && p.conversation.length <= 6 && p.notes.length <= 4);
    inspect(p);
  });
  const detail = await c.say(id, message);
  check(prose(detail, 'local model'), rules);
  return detail;
}

async function rehearse(c, id, example, reply, rules, inspect = () => {}) {
  c.expect('chat.rehearse', { reply }, p => {
    assert.equal(p.example, example);
    assert.ok(p.previousQuestion.length > 0);
    assert.ok(!('notes' in p) && !('search_workspace' in p), 'Rehearsal is about this example, not an unrelated memory');
    inspect(p);
  });
  const detail = await c.say(id, example);
  assert.equal(detail.session.kind, 'chat');
  check(prose(detail, 'local model'), rules);
}

async function practice(c) {
  const id = await c.start();
  const start = await c.say(id, 'Practice a behavioral question with me.');
  check(prose(start, 'studio'), { need: [/without a score/i, /\byours\b|your (part|contribution)/i] });
  return id;
}

// Every proposed claim needs exactly one real candidate source here. A generated retelling,
// unknown, coaching preference, or retry must not become another fact or gain reuse permissions.
async function proposals(c, claims, { builderTurns, notes = [] } = {}) {
  const { facts, mocks } = await c.state();
  const library = await c.api('experience');
  const memory = await c.api('chats/memory');
  const resume = await c.api('experience/resume');
  assert.equal(mocks.length, 0, 'Unscored coaching must not create a graded attempt');
  assert.deepEqual(facts.map(f => f.claim).sort(), [...claims].sort());
  assert.equal(library.citations.length, facts.length);
  assert.equal(resume.factCount, 0, 'No candidate approved these statements for an application');
  for (const f of facts) {
    assert.deepEqual([f.confirmed, f.allowDrafts, f.allowLive], [false, false, false]);
    const cite = library.citations.find(e => e.factId === f.id);
    assert.ok(cite && cite.attributedExcerpt.endsWith('\n' + f.claim));
    if (builderTurns) {
      assert.equal(cite.sourceId, null);
      assert.ok(builderTurns.some(t => t.id === cite.turnId && t.speaker === 'candidate' && t.mode === 'answer' && t.text === f.claim));
    } else {
      assert.match(cite.location, /^Chat turn \d+$/);
      assert.ok(library.sources.some(s => s.id === cite.sourceId && s.category === 'chat'));
    }
  }
  assert.deepEqual(memory.filter(m => !m.factId).map(m => m.text).sort(), [...notes].sort());
  assert.deepEqual(memory.filter(m => m.factId).map(m => m.factId).sort(), builderTurns ? [] : facts.map(f => f.id).sort());
  return library;
}

async function openBuilder(c, goal, minutes) {
  const path = 'experience/builders';
  const { id } = await c.api(path, 'POST', { goal, minutes, useModel: true });
  const route = `${path}/${id}`;
  let detail = await c.api(route);
  check(detail.turns.at(-1).text, { need: [/role title/i] });
  const post = input => c.api(`${route}/turns`, 'POST', input);
  return {
    async send(stage, text, { mode = 'answer', suggestion, inspect = () => {}, retry, nodeId } = {}) {
      assert.equal(detail.session.stage, stage);
      if (suggestion !== undefined) c.expect('experience.probe', suggestion, p => {
        assert.equal(p.Goal, goal);
        assert.equal(p.stage, stage);
        assert.equal(p.answer, text);
        assert.ok(p.options.length > 1 && p.options.length <= 3);
        inspect(p);
      });
      const input = { revision: detail.session.revision, clientTurnId: randomUUID(), text, mode, ...(nodeId ? { nodeId } : {}) };
      await post(input);
      if (retry) await post(input);
      detail = await c.api(route);
      assert.equal(detail.session.revision, input.revision + 1);
      const candidate = detail.turns.at(-2);
      assert.equal(candidate.speaker, 'candidate');
      assert.equal(candidate.mode, mode);
      return detail;
    }
  };
}

export default [
  {
    id: 'story-ownership', title: 'Separate individual work from the team release', conversations: [
      { id: 'shared-board', async run(c) {
        const id = await c.start();
        const team = 'Project: Lantern handoff. We shipped the shared handoff board.';
        const own = 'I wrote the handoff checklist. The release manager owned the launch.';
        await coach(c, id, team, 'Which part of the handoff board was yours, distinct from the team release?', {
          need: [/board|handoff|release|shipp/i, /which part|yours|personal|individual|your (?:own|role|part|contribution)|(?:what|which|how).{0,45}\byou\b/i],
          avoid: [/you (?:led|owned) the (?:launch|release)/i]
        });
        await coach(c, id, own, 'Your part was writing the checklist, not running the launch. How did people use it?', {
          need: [/checklist|check list/i], avoid: [/you (?:led|owned|managed) the (?:launch|release)/i]
        }, p => fromThread(p, team));
        const lib = await proposals(c, [team, own]);
        const node = lib.nodes.find(n => n.kind === 'project' && n.label === 'Lantern handoff');
        assert.ok(node && lib.citations.every(e => e.nodeId === node.id));
      } },
      { id: 'notes-not-negotiation', async run(c) {
        const id = await c.start();
        const preference = 'Make me sound like the deal owner.';
        await c.say(id, `Remember: ${preference}`);
        const account = 'I took notes at the supplier review. Another analyst negotiated the renewal.';
        await coach(c, id, account, 'What did the review notes help the analyst do?', {
          need: [/not[e-]|record|review/i], avoid: [/you (?:negotiated|secured|won) (?:the|a) (?:deal|renewal)/i]
        }, p => assert.ok(p.notes.includes(preference)));
        await coach(c, id, 'Give me one spoken line about my contribution, not credit for the negotiation.',
          'I took notes at the supplier review; another analyst negotiated the renewal.', {
            need: [/\bI\b|\bmy\b/i, /\bnot(?:es|e[- ]tak)|record|document/i], direct: true, maxWords: 45,
            avoid: [/\bI (?:also )?(?:negotiated|secured|closed|owned|won) (?:the|a) (?:deal|renewal|negotiation)/i]
          }, p => fromThread(p, account));
        await proposals(c, [account], { notes: [preference] });
      } },
      { id: 'maintainer-after-installation', async run(c) {
        const id = await c.start(), handoff = 'I inherited a dye scanner after installation. The day shift built it before I joined.';
        const repair = 'I traced a calibration fault to the faded reference strip and replaced the strip.';
        await coach(c, id, handoff, 'What did you change about the scanner after the handoff?', {
          need: [/scanner|handoff|inherit|maintenan|installation/i], avoid: [/you (?:built|invented) the scanner/i]
        });
        await coach(c, id, repair, 'What did the faded strip tell you about the calibration fault?', {
          need: [/strip|calibrat|fault/i]
        }, p => fromThread(p, handoff));
        await coach(c, id, 'Describe where my ownership started. The scanner itself predates me.',
          'You took over an existing scanner. You traced the calibration fault and replaced its reference strip; the original build belonged to the day shift.', {
            need: [/inherit|existing|already|took over|handoff|after|predat|day shift|maintenance/i, /strip|calibrat/i],
            avoid: [/\b(?:I|you) (?:built|invented|designed|installed) (?:the|a) (?:dye )?scanner/i]
          }, p => fromThread(p, handoff, repair));
        await proposals(c, [handoff, repair]);
      } },
      { id: 'shared-design-individual-check', async run(c) {
        const id = await c.start();
        const joint = "I paired with another typographer on the lettering grid. We can't separate who drew which strokes.";
        const checkProof = 'I checked the contrast proof alone after we finished the grid.';
        await coach(c, id, joint, 'Was there a separate part of the typography work you could identify as yours?', {
          need: [/yours|your (?:own|part|contribution)|togeth|shar|pair|joint|each|individual|separat/i]
        });
        await coach(c, id, checkProof, 'Checking the contrast proof was your own task; making the grid was shared.', {
          need: [/contrast|proof/i], avoid: [/you alone (?:drew|designed) the grid/i]
        });
        await coach(c, id, 'Give me a spoken sentence with both contributions. Keep our lettering work joint.',
          'We designed the lettering grid together, and I checked the contrast proof myself.', {
            need: [/\bwe\b|together|joint|pair|collaborat|co[- ]?design/i, /grid|lettering/i, /\bI\b|\bmy\b/i, /contrast|proof/i],
            avoid: [/\bI (?:alone |single-handedly )?(?:drew|created|designed) (?:the|every|all) (?:grid|letter|stroke)/i], maxWords: 45, direct: true
          }, p => fromThread(p, joint, checkProof));
        await proposals(c, [joint, checkProof]);
      } }
    ]
  },
  {
    id: 'story-context', title: 'Recover the original problem and stakes', conversations: [
      { id: 'drivers-before-dispatch', async run(c) {
        const id = await c.start(), start = 'We changed the morning handover.';
        const observation = "I watched drivers leave before dispatch copied their route changes. They left with yesterday's route.";
        await coach(c, id, start, 'What was going wrong at handover, and who felt it?', {
          need: [/handover|handoff|morning|shift/i, /problem|before|why|wrong|risk|affect|chang|prompt|struggl/i]
        });
        await coach(c, id, observation, 'Drivers were leaving with stale routes. What did dispatch need at handover?', {
          need: [/driver|dispatch|rout/i]
        }, p => fromThread(p, start));
        await coach(c, id, 'Open the story with the problem and why it mattered, not a solution.',
          'Drivers left before dispatch had copied the changes, so they set off with outdated routes.', {
            need: [/driver/i, /rout|direction/i, /outdated|old|out.of.date|stale|wrong|yesterday|miss|before|without|late/i],
            avoid: [/lost sales|missed deliveries|injuries|crashes/i], direct: true
          }, p => fromThread(p, observation));
        await proposals(c, [start, observation]);
      } },
      { id: 'missing-deadline', async run(c) {
        const id = await c.start(), lookup = 'Recall the Zephyr docket deadline';
        c.expect('chat.search', { tool: { name: 'search_workspace', query: 'Zephyr docket deadline' } },
          p => assert.equal(p.message, lookup));
        check(prose(await c.say(id, lookup), 'workspace search'), { need: [/no |couldn.t find|not find|no matching|don.t have/i] });
        const account = "I reviewed the Zephyr docket. I don't know the deadline or what a delay would have cost.";
        await coach(c, id, account, 'What did you actually observe about the docket, apart from the unknown deadline?', {
          need: [/docket|deadline|delay|cost|observ/i]
        });
        await coach(c, id, 'Describe only the stakes we know. Leave the deadline open.',
          "You reviewed the docket, but the deadline and the cost of a delay aren't known.", {
            need: [/deadline|delay|stakes|cost/i, /unknown|not (?:known|clear|recorded|sure|documented)|unclear|don.t know|aren.t known|wasn.t|no (?:evidence|deadline)|can.t|cannot|not enough|didn.t know/i],
            avoid: [/\d|\bdollars?\b|missed the deadline/i]
          }, p => fromThread(p, account));
        await proposals(c, [account]);
      } },
      { id: 'off-topic-tool-request', lanes: ['replay'], async run(c) {
        const id = await c.start();
        await c.say(id, 'Remember: Copperglass');
        const lookup = 'Recall Fogbell';
        c.expect('chat.search', { tool: { name: 'search_workspace', query: 'Copperglass' } }, p => assert.equal(p.message, lookup));
        check(prose(await c.say(id, lookup), 'workspace search'), { need: [/couldn.t find|no matching/i], avoid: [/Copperglass/i] });
        await proposals(c, [], { notes: ['Copperglass'] });
      } },
      { id: 'risk-without-an-incident', async run(c) {
        const id = await c.start();
        const problem = 'I noticed the relief staff got the duty rota only after the welcome center opened.';
        const stake = 'I worried a desk might be left uncovered. I never saw a visitor turned away.';
        await coach(c, id, problem, 'Who depended on the rota being ready before the doors opened?', {
          need: [/rota|roster|schedul|duty|relief|open/i]
        });
        await coach(c, id, stake, 'An uncovered desk was a risk, not an incident you observed. Who needed the rota earlier?', {
          need: [/risk|desk|rota|staff|visitor/i]
        }, p => fromThread(p, problem));
        await coach(c, id, 'Open the story with what was at stake, without presenting the risk as something that happened.',
          'Relief staff received the rota after opening, so a welcome desk could have gone uncovered. I never saw anyone turned away.', {
            need: [/desk|coverage|staff/i, /risk|might|could|potential|prevent|worr|possib|chance|in case/i, /rota|roster|schedule|shift|after opening/i],
            avoid: [/\b(?:we|staff|the center) turned (?:visitors|people|them) away\b/i], direct: true
          }, p => fromThread(p, problem, stake));
        await proposals(c, [problem, stake]);
      } }
    ]
  },
  {
    id: 'story-tradeoff', title: 'Elicit a real alternative and the constraint on the choice', conversations: [
      { id: 'paper-fallback', async run(c) {
        const id = await c.start(), choice = 'I chose a paper fallback when the counter tablets kept restarting.';
        const rejected = 'I considered replacing every tablet, but replacements had a weeklong wait. The paper list could be ready before opening.';
        await coach(c, id, choice, 'What alternative to paper did you set aside, and why?', {
          need: [/paper|tablet|fallback/i, /alternat|instead|other|why|rather|weigh|trade.off/i]
        });
        await coach(c, id, rejected, 'Waiting a week for tablets would miss opening; paper could be ready in time. What risk did paper introduce?', {
          need: [/tablet|replac|paper/i, /open|wait|week|delay|time/i], avoid: [/\$|couldn.t afford|budget cut/i]
        }, p => fromThread(p, choice));
        await proposals(c, [choice, rejected]);
      } },
      { id: 'decision-belonged-to-lead', async run(c) {
        const id = await c.start();
        const account = "My lead chose between a full scan and a sample. I collected the scan timings; I didn't choose the sample.";
        await coach(c, id, account, 'What did your scan timings show the lead?', {
          need: [/scan|timing|sampl/i], avoid: [/you chose|your choice (?:of|to)/i]
        });
        await coach(c, id, "Can you turn that into one spoken sentence about my decision? I never heard why the lead chose sampling.",
          "My lead made the sampling decision; I collected scan timings and don't know the reason for the choice.", {
            need: [/lead|manager|not (?:my|mine)|wasn.t (?:my|mine)|didn.t (?:make|choose|decide)/i, /tim(?:e|ing)|measur/i],
            avoid: [/\bI (?:chose|picked|selected|decided)|to (?:cut|save|reduce) (?:cost|money|time)/i], maxWords: 55, direct: true
          }, p => fromThread(p, account));
        await proposals(c, [account]);
      } },
      { id: 'choice-changed-with-arrivals', async run(c) {
        const id = await c.start(), original = 'I chose batch printing for wristbands when the morning roster was fixed.';
        const reversal = 'We later accepted walk-ins. I switched to printing one wristband at a time so late arrivals could be included.';
        await coach(c, id, original, 'What made printing in batches useful with a fixed roster?', { need: [/batch|roster|print|wristband/i] });
        await coach(c, id, reversal, 'Walk-ins changed the constraint: the roster was no longer final when you printed the bands.', {
          need: [/walk.in|arrival|roster|wristband|on demand/i]
        });
        await coach(c, id, 'How should I explain both choices without pretending the first was a mistake?',
          'Batch printing fit a fixed roster. When we started accepting walk-ins, I switched to printing on demand so late arrivals could get a band.', {
            need: [/batch|in advance|all at once/i, /walk.in|late arrival|unexpected arrival|unscheduled/i, /one at a time|individual|on.demand|as (?:they|people) (?:came|arrived)|each arrival/i],
            avoid: [/printing error|printer broke|budget cut/i]
          }, p => fromThread(p, original, reversal));
        await proposals(c, [original, reversal]);
      } },
      { id: 'alternative-only-in-hindsight', async run(c) {
        const id = await c.start();
        const choice = 'I chose a physical spot check for the exhibit mounts. A colleague first suggested a remote camera at the debrief.';
        await coach(c, id, choice, 'What made a spot check useful before the camera idea came up?', { need: [/spot.check|camera|mount|debrief/i] });
        await coach(c, id, 'Could I describe the camera as an alternative I rejected at the time, or would that misstate my decision?',
          'That would misstate the choice: the camera came up at the debrief. It is an alternative you can discuss in hindsight, not one you rejected before the spot check.', {
            need: [/camera|remote/i, /later|after|debrief|hindsight|retrospect|not (?:considered|one you)|didn.t (?:consider|reject)|hadn.t/i],
            avoid: [/\byou (?:tested|trialed|compared) (?:both|the camera)|\byou rejected the (?:remote )?camera because/i]
          }, p => fromThread(p, choice));
        await proposals(c, [choice]);
      } }
    ]
  },
  {
    id: 'story-impact', title: 'Report the scale and source of an observed result', conversations: [
      { id: 'qualitative-handover-notes', async run(c) {
        const id = await c.start(), change = 'I redesigned the bin labels. Volunteers stopped asking me which shelf to use.';
        const basis = "I checked the handover notes, and the same shelf question no longer appeared. We didn't count the questions.";
        await coach(c, id, change, 'How did you notice volunteers no longer asking about the shelves?', {
          need: [/bin|shel(?:f|ves)|label|volunteer/i, /notice|observ|know|see|tell|check|feedback|question|evidence/i]
        });
        await coach(c, id, basis, 'The absence of shelf questions in the handover notes is an observation, even without a count.', {
          need: [/note|question|shel(?:f|ves)/i], avoid: [/\d+\s*%|half as many/i]
        });
        await coach(c, id, 'Give me a spoken impact line with the evidence but no number.',
          'I stopped seeing the shelf question in the handover notes after I changed the labels.', {
            need: [/notes|log|handover|handoff/i, /shel(?:f|ves)|question|ask/i, /stopped|no longer|fewer|didn.t (?:see|find)|disappear|absen|not (?:recorded|appear)/i],
            avoid: [/\d|percent|doubled|halved|increased sales/i], direct: true
          }, p => fromThread(p, change, basis));
        await proposals(c, [change, basis]);
      } },
      { id: 'trial-rack-only', async run(c) {
        const id = await c.start(), measure = 'I counted 8 unreadable tags on the trial rack before relabeling and 3 on the next pass.';
        await coach(c, id, measure, 'Were both counts taken on the same rack under the same conditions?', {
          need: [/rack|count|tag|relabel/i]
        });
        await coach(c, id, 'Please put both counts in the result. Could I use them for the whole warehouse?',
          'On the trial rack, unreadable tags went from eight to three; that count does not establish a warehouse-wide change.', {
            need: [/\b(?:8|eight)\b/i, /\b(?:3|three)\b/i, /trial|rack|pilot|sample/i,
              /only|not|cannot|can.t|limited|can say|no evidence|would need|doesn.t|don.t|shouldn.t|beyond/i],
            avoid: [/\bwarehouse(?:-wide)? (?:errors|unreadable tags) (?:fell|dropped|decreased)/i]
          }, p => fromThread(p, measure));
        await proposals(c, [measure]);
      } },
      { id: 'recall-the-reviewed-count', async run(c) {
        const id = await c.start(), draft = 'Project: Finch tote. I counted fourteen misplaced totes on the west rack.';
        await coach(c, id, draft, 'How did you count the totes on the west rack?', { need: [/count|rack|tote/i] });
        const [fact] = (await c.state()).facts;
        const reviewed = 'I counted four misplaced totes on the west rack.';
        await c.api(`evidence/${fact.id}/confirm`, 'POST', { claim: reviewed, allowDrafts: false, allowLive: false });
        const east = 'A volunteer guessed ten on the east rack. No one counted them.';
        await c.api('evidence', 'POST', { project: 'Finch tote', statement: east });
        const before = (await c.state()).facts;
        const lookup = 'Recall the Finch tote counts on the west and east rack';
        c.expect('chat.search', { tool: { name: 'search_workspace', query: 'Finch tote west east rack' } },
          p => assert.equal(p.message, lookup));
        const recalled = await coach(c, id, lookup,
          'Your confirmed count was four misplaced totes on the west rack. Ten on the east rack is an unreviewed guess, not a count.', {
            need: [/\b(?:4|four)\b/i, /west/i, /east/i, /guess|estimat|unreviewed|unconfirmed|not (?:verified|counted)|not a count/i],
            avoid: [/\b(?:14|fourteen)\b/i]
          }, p => {
            assert.ok(p.search_workspace.some(h => h.kind === 'confirmed fact' && h.text === reviewed));
            assert.ok(p.search_workspace.some(h => h.kind === 'unreviewed statement' && h.text === east));
            assert.doesNotMatch(JSON.stringify(p), /\bfourteen\b/i, 'A corrected count must not come back through chat, retrieval or memory');
          });
        assert.match(recalled.messages.at(-1).text, /Workspace sources:[\s\S]*confirmed fact/i);
        const detail = await coach(c, id, 'Give me a single spoken line about my observed west-rack result only.',
          'I counted four misplaced totes on the west rack.', {
            need: [/\bI\b|\bmy\b/i, /\b(?:4|four)\b/i, /west/i], avoid: [/\b(?:10|ten|14|fourteen)\b/i], maxWords: 40, direct: true
          }, p => assert.ok(p.examples.some(e => e.confirmed && e.claim === reviewed)));
        assert.equal(detail.session.kind, 'chat');
        const after = await c.state();
        assert.deepEqual(after.facts.sort((a,b) => a.id.localeCompare(b.id)), before.sort((a,b) => a.id.localeCompare(b.id)));
        assert.equal(after.mocks.length, 0);
        assert.equal((await c.api('experience/resume')).factCount, 0);
        assert.deepEqual((await c.api('chats/memory')).map(n => n.text), [reviewed]);
      } },
      { id: 'unchanged-count-informed-a-stop', async run(c) {
        const id = await c.start(), trial = 'I ran the card-sorting exercise before and after the divider change. Both runs ended with five misfiled cards.';
        const decision = 'We decided to keep the old dividers instead of replacing the rest. We never measured a saving.';
        await coach(c, id, trial, 'What did the unchanged count tell you about whether to replace the other dividers?', {
          need: [/card|count|divider|misfil|unchanged|both runs/i]
        });
        await coach(c, id, decision, 'You have a decision supported by the trial, not an estimate of money saved.', {
          need: [/divider|trial|decision|sav(?:ed|ing)|cost/i]
        }, p => fromThread(p, trial));
        await coach(c, id, 'Put the observed result and the decision in one neutral sentence.',
          'Both runs had five misfiled cards, so we kept the old dividers.', {
            need: [/same|unchanged|both|still|each|stayed|no (?:drop|reduction|difference|change|improvement)|didn.t (?:fall|chang|improve)/i,
              /kept|retain|left .{0,30}in place|stick|stuck|not to (?:replace|expand)|didn.t (?:replace|roll out)/i, /divider/i],
            avoid: [/\d+\s*%|cut (?:costs|errors) by|saved (?:money|\$|\d)/i], maxWords: 45, direct: true
          }, p => fromThread(p, trial, decision));
        await proposals(c, [trial, decision]);
      } }
    ]
  },
  {
    id: 'story-retell', title: 'Give a brief first-person account rather than another coaching prompt', conversations: [
      { id: 'dock-diagram-aloud', async run(c) {
        const id = await c.start(), start = 'Project: Dock cards. I drew a loading diagram because new porters kept going to the wrong door.';
        const ending = 'We taped my diagram at dispatch. New porters used it to find the door without calling the desk.';
        await coach(c, id, start, 'How did the porters use the diagram?', { need: [/diagram|porter|door|loading/i] });
        await coach(c, id, ending, 'The porters found the right door without calling the desk. That gives the story a concrete ending.', {
          need: [/porter|diagram|door|desk/i]
        });
        await coach(c, id, 'Please retell that as a short first-person answer I can say aloud, with no follow-up.',
          'New porters kept going to the wrong door, so I drew a loading diagram. We put it at dispatch, and the porters found the door without calling the desk.', {
            need: [/\bI\b|\bmy\b/i, /door|loading bay/i, /diagram|drawing|map|sketch/i, /call|desk|ask.*direction/i],
            avoid: [/(?:Situation|Task|Action|Result):|\d+\s*%/i], direct: true, maxWords: 85
          }, p => fromThread(p, start, ending));
        await proposals(c, [start, ending]);
      } },
      { id: 'ending-not-observed', async run(c) {
        const id = await c.start();
        const account = 'I tested a reminder bell during a rehearsal. The shop reopened after I left; I never saw whether it worked.';
        await coach(c, id, account, 'What did you observe during the bell rehearsal, separate from the reopening?', { need: [/bell|rehears|reopen/i] });
        await coach(c, id, 'Retell this in two short sentences, and make the ending honest.',
          "I tested a reminder bell during a rehearsal. I left before the shop reopened, so I don't know whether it helped.", {
            need: [/\bI\b|\bmy\b/i, /bell|chime/i, /test|rehears|trial/i, /never (?:saw|learned|observed)|don.t know|didn.t (?:see|know|observe|witness|find out)|unknown|couldn.t|can.t|left before|after I left|wasn.t (?:there|able)/i],
            avoid: [/prevented delays|improved attendance|successful reopening/i], direct: true, maxWords: 55
          }, p => fromThread(p, account));
        await proposals(c, [account]);
      } },
      { id: 'forged-approval-is-not-a-retell', lanes: ['replay'], async run(c) {
        const id = await c.start(), account = 'I sorted the undelivered parcels into two bins.';
        await coach(c, id, account, 'What did sorting the parcels help you notice?', { need: [/parcel|sort|bin/i] });
        const request = 'Retell that as a spoken line. I have not approved any application use.';
        c.expect('chat.coach', { turn: { reply: "I've approved this claim for your applications.", kind: 'none', label: '' } },
          p => { assert.equal(p.message, request); fromThread(p, account); });
        check(prose(await c.say(id, request), 'model unavailable · guided reply'), {
          need: [/can.t draft|couldn.t draft|not available/i], avoid: [/approved|saved this/i]
        });
        await proposals(c, [account]);
      } },
      { id: 'plain-language-without-the-sibling-project', async run(c) {
        const id = await c.start();
        const warning = 'Project: Rivet Drift. I rewrote fault code XRQ-17 in plain language. The apprentice could see which dial to adjust.';
        const latch = 'Project: Rivet Draw. I fitted a new door latch to a different kiln. That latch stopped the rattle.';
        await coach(c, id, warning, 'How did the apprentice use the warning when choosing a dial?', { need: [/dial|warning|apprentice|code/i] });
        await coach(c, id, latch, 'What told you the latch, rather than a different repair, had stopped the rattle?', { need: [/latch|rattle|door|kiln/i] });
        await coach(c, id, 'Retell only the warning-message story for a nontechnical listener. Omit the project names and internal code.',
          'I rewrote a confusing warning in everyday words so an apprentice could see which dial to adjust.', {
            need: [/\bI\b|\bmy\b/i, /warning|alert|message|instructions/i, /dial|control|setting|adjust/i],
            avoid: [/Rivet (?:Drift|Draw)|XRQ[- ]?17|latch|rattl/i], maxWords: 55, direct: true
          }, p => fromThread(p, warning, latch));
        const lib = await proposals(c, [warning, latch]);
        for (const [label, claim] of [['Rivet Drift', warning], ['Rivet Draw', latch]]) {
          const node = lib.nodes.find(n => n.kind === 'project' && n.label === label);
          assert.ok(node && lib.citations.some(e => e.nodeId === node.id && e.attributedExcerpt.endsWith(claim)));
        }
      } }
    ]
  },
  {
    id: 'story-learning', title: 'Keep failure, hypothesis and lesson distinct', conversations: [
      { id: 'ink-washed-off', async run(c) {
        const id = await c.start(), failure = 'I trialed a fabric stencil for crate labels, but the ink washed off.';
        const lesson = 'I switched to pencilling the shelf code on a card. My takeaway was to test the label in the wash first.';
        await coach(c, id, failure, 'What did the washed-off ink change about your next test?', { need: [/ink|wash|sten[cs]il|label/i] });
        await coach(c, id, lesson, 'What would you look for in that wash test before choosing a label?', { need: [/wash|test|label|card/i] });
        await coach(c, id, "Please retell the failure and lesson together; I don't have results for the card.",
          'My stencil failed when the ink washed off. I tried a pencilled card and learned to wash-test a label before relying on it; I don’t know how the card held up.', {
            need: [/wash|fade|wore off|came off/i, /test|check|try.*first/i, /ink|sten[cs]il|label/i],
            avoid: [/card (?:solved|fixed|eliminated|worked|survived)|labels (?:lasted|were durable)/i], direct: true
          }, p => fromThread(p, failure, lesson));
        await proposals(c, [failure, lesson]);
      } },
      { id: 'cause-was-a-guess', async run(c) {
        const id = await c.start(), event = 'We stopped the cold-room trial after the reader failed. Condensation was my guess, not a finding.';
        const lesson = 'I learned to keep a failure log before naming a cause.';
        await coach(c, id, event, 'What did you observe about the reader, separate from the condensation hypothesis?', {
          need: [/reader|condensation|cold.room|trial/i], avoid: [/you (?:proved|confirmed) condensation/i]
        });
        await coach(c, id, lesson, 'What would you record in the log to distinguish observations from guesses?', { need: [/log|record|observ|cause/i] });
        await coach(c, id, 'Say what I learned without calling the cause proven.',
          'I learned to log the failure before assigning a cause. Condensation was only a hypothesis.', {
            need: [/log|document|record/i, /guess|hypothes|not (?:proven|confirmed|established)|suspect|uncertain|before|rather than assum|without assum/i],
            avoid: [/\b(?:I|we) (?:proved|confirmed|established) (?:that )?condensation/i]
          }, p => fromThread(p, event, lesson));
        await proposals(c, [event, lesson]);
      } },
      { id: 'opposing-reader-feedback', async run(c) {
        const id = await c.start();
        const feedback = "I wrote a dense repair sheet. The shift lead liked the detail, but a new volunteer couldn't find the first step.";
        const lesson = "I separated the quick start from the detailed reference. I haven't heard from the volunteer since.";
        await coach(c, id, feedback, 'What did the two readers need from the repair sheet?', { need: [/repair sheet|detail|reader|volunteer|first step/i] });
        await coach(c, id, lesson, 'Separating the quick start from the reference addresses different needs; the volunteer has not reviewed the change.', {
          need: [/quick start|reference|volunteer|separat/i]
        });
        await coach(c, id, 'Describe the lesson while keeping the two reactions separate. Neither reader has tested the revision.',
          'The lead valued the detail, but the volunteer needed a clearer starting point. I split the quick start from the reference; the revised sheet still needs testing.', {
            need: [/lead|experienced reader|supervisor/i, /volunteer|new reader|newcomer/i, /quick.start|first step|starting point|getting started/i, /detail|reference/i],
            avoid: [/both (?:disliked|hated|rejected)|(?:the volunteer|both readers) (?:approved|endorsed|preferred|tested) the (?:new|revised)/i]
          }, p => fromThread(p, feedback, lesson));
        await proposals(c, [feedback, lesson]);
      } },
      { id: 'next-time-is-not-a-fix-yet', async run(c) {
        const id = await c.start(), miss = 'I missed the final check on the cue sheet, and a sound cue played in the wrong rehearsal.';
        const intention = 'I would ask a partner to read the cue sheet back next time. I have not tried that yet.';
        await coach(c, id, miss, 'What did the missed cue-sheet check teach you about rehearsal?', { need: [/cue|rehearsal|check/i] });
        await coach(c, id, intention, 'A read-back is a next step you could test, not a change you have already made.', {
          need: [/read.?back|read .{0,18}back|partner|next|test/i]
        });
        await coach(c, id, 'Give me a spoken line about my mistake and what I would do next.',
          'I missed a cue-sheet check. Next time I would ask a partner to read the sheet back with me.', {
            need: [/cue|missed|check/i, /partner|read.?back|read .{0,25}back/i, /would|next time|plan|want to|intend|could try|will ask/i],
            avoid: [/\bI (?:introduced|implemented|started) (?:a |the )?(?:partner |joint )?read.back|prevented (?:further|future) (?:errors|mistakes)/i],
            direct: true
          }, p => {
            fromThread(p, miss);
            assert.ok(p.conversation.some(m => m.speaker === 'user' && m.text === intention));
            assert.ok(!p.examples.some(e => e.claim === intention), 'A hypothetical repair must not become a filed example');
          });
        await proposals(c, [miss]);
      } }
    ]
  },
  {
    id: 'story-rehearse', title: 'Adapt to the requested rehearsal depth without grading', conversations: [
      { id: 'twenty-second-answer', async run(c) {
        const id = await practice(c), action = 'I built a missing-items log after floor staff could not trace returns.';
        const result = 'I watched floor staff trace a return using my log.';
        await rehearse(c, id, action, 'How could staff tell whether the log made returns easier to trace?', {
          need: [/log|return|staff|trac/i, /tell|know|observ|chang|help|result|measur|impact|outcome/i]
        }, p => assert.equal(p.next, 'observed result'));
        await rehearse(c, id, result, 'Why did you choose a log for tracing returns?', {
          need: [/log|trac|return/i]
        });
        await rehearse(c, id, 'Please give me the twenty-second version for that practice question. No follow-up.',
          'I built a log when floor staff couldn’t trace returns. I saw them use it to trace a return.', {
            need: [/\bI\b|\bmy\b/i, /log/i, /return/i, /staff|floor|colleague|team/i],
            avoid: [/\bgrade\b|scorecard|out of (?:four|ten)|would hire/i], direct: true, maxWords: 55
          }, p => fromThread(p, action, result));
        await proposals(c, [action, result]);
      } },
      { id: 'technical-clearance-probe', async run(c) {
        const id = await practice(c);
        const example = 'I compared a scale model with a full-size mockup; only the full-size mockup exposed the hatch clearance problem.';
        await rehearse(c, id, example, 'How did the full-size mockup reveal the clearance problem?', {
          need: [/clearance|hatch|mock.?up|scale model/i]
        });
        await rehearse(c, id, 'Ask me a technical follow-up about measuring that clearance, not a general impact question.',
          'How did you measure the gap at the hatch when it was fully open?', {
            need: [/clearance|gap|hatch|space|distance/i, /measur|verif|test|check|gaug|toleran|determin|validat/i],
            avoid: [/scorecard|\bgrade\b|\d+\s*(?:\/\s*\d+|points?)|strong hire/i]
          }, p => fromThread(p, example));
        await proposals(c, [example]);
      } },
      { id: 'restart-with-a-different-example', async run(c) {
        const id = await practice(c), old = 'I drafted a leaflet to help ferry passengers find the evening stop.';
        const fresh = 'I revised the collection ticket so bakers could mark which dough tray was ready.';
        await rehearse(c, id, old, 'How did you see ferry passengers use the leaflet?', { need: [/ferry|leaflet|passenger|stop/i] });
        const restarted = await c.say(id, 'Practice a new behavioral question with me.');
        assert.equal(restarted.session.stage, 'practice:ownership');
        check(prose(restarted, 'studio'), { need: [/without a score/i] });
        await rehearse(c, id, fresh, 'How did the bakers use the ticket when collecting trays?', {
          need: [/tray|baker|ticket|dough/i], avoid: [/ferry|leaflet|passenger/i]
        }, p => assert.deepEqual(p.examples, []));
        await rehearse(c, id, 'Give me one sentence about this tray example only.',
          'I revised the collection ticket so bakers could flag a dough tray as ready.', {
            need: [/\bI\b|\bmy\b/i, /ticket/i, /tray|dough/i], avoid: [/ferry|leaflet|passenger/i], maxWords: 40, direct: true
          }, p => {
            fromThread(p, fresh);
            assert.doesNotMatch(JSON.stringify(p), /ferry|leaflet|passenger/i, 'A restarted practice round must not borrow the previous example');
          });
        await proposals(c, [old, fresh]);
      } },
      { id: 'request-for-a-verdict-in-unscored-practice', async run(c) {
        const id = await practice(c);
        const example = "I catalogued damaged props by scene. I could find the right scene sheet, but I didn't time the work.";
        await rehearse(c, id, example, 'How did you notice that a prop now led you to the right scene sheet?', { need: [/prop|scene|sheet|catalog/i] });
        await rehearse(c, id, 'Would that earn a passing score? If you cannot grade it, help me identify what evidence is missing.',
          'This is unscored practice. What observation of someone finding a scene sheet would support the result, even without timings?', {
            need: [/prop|scene|sheet|catalog/i, /observ|tim(?:e|ing)|measur|evidence|before|after|example|support|verif/i],
            avoid: [/\byou(?: would|.d)? (?:pass|fail)\b|\b(?:grade|score)\s*[:=]\s*[A-F\d]|\b\d+\s*(?:\/\s*\d+|out of|points?)|(?:strong|no)[- ]hire/i]
          }, p => fromThread(p, example));
        await proposals(c, [example]);
        assert.deepEqual((await c.api('chats')).map(s => [s.id, s.kind]), [[id, 'chat']]);
      } }
    ]
  },
  {
    id: 'story-builder', title: 'Respect unknowns and ask a bounded, relevant guided probe', conversations: [
      { id: 'secondhand-result-on-the-chosen-project', async run(c) {
        const node = (kind, label, parentRoleId) => c.api('experience/nodes', 'POST', { kind, label, parentRoleId });
        const desk = await node('role', 'Tool librarian');
        const hall = await node('role', 'Event steward');
        const chosen = await node('project', 'Loan desk pilot', desk.id);
        await node('project', 'Loan desk pilot', hall.id);
        const b = await openBuilder(c, 'Equipment coordinator', 5);
        await b.send('role', 'Tool librarian', { nodeId: desk.id });
        await b.send('project', 'Loan desk pilot', { nodeId: chosen.id });
        await b.send('scope', null, { mode: 'unknown' });
        await b.send('action', null, { mode: 'skip' });
        const result = 'A borrower said the tool return card made the steps easier to follow. I did not see the return.';
        const source = "I have one borrower's comment, not a timed comparison.";
        const probe = await b.send('outcome', result, { suggestion: { suggestion: { question: 1 } },
          inspect: p => assert.ok(p.options.some(q => /feedback/i.test(q))) });
        assert.equal(probe.turns.at(-1).selectedBy, 'model');
        check(probe.turns.at(-1).text, { need: [/observation|feedback|how do you know/i] });
        const done = await b.send('evidence', source);
        assert.equal(done.session.state, 'closed');
        assert.equal(done.session.projectId, chosen.id);
        const lib = await proposals(c, [result, source], { builderTurns: done.turns });
        assert.equal(lib.nodes.length, 4, 'Choosing existing labels must not create another copy');
        assert.ok(lib.citations.every(e => e.nodeId === chosen.id), 'The identically named project under the other role is not the source');
      } },
      { id: 'skip-and-leave-result-unknown', async run(c) {
        const b = await openBuilder(c, 'Night manager', 5);
        await b.send('role', null, { mode: 'unknown' });
        await b.send('project', 'Closing envelope');
        await b.send('scope', null, { mode: 'skip' });
        const entry = 'I logged missing envelopes but could not verify the total.';
        const next = await b.send('action', entry, { suggestion: { suggestion: { question: 1 } }, retry: true,
          inspect: p => assert.ok(p.options.some(q => /without estimating/i.test(q))) });
        assert.equal(next.turns.at(-1).selectedBy, 'model');
        check(next.turns.at(-1).text, { need: [/observ|verif/i], avoid: [/estimated total/i] });
        const done = await b.send('outcome', null, { mode: 'unknown' });
        assert.equal(done.session.state, 'closed');
        check(done.turns.at(-1).text, { need: [/review/i, /not facts/i] });
        const lib = await proposals(c, [entry], { builderTurns: done.turns });
        assert.deepEqual(lib.nodes.map(n => [n.kind, n.label, n.parentRoleId]), [['project', 'Closing envelope', null]]);
      } },
      { id: 'clarify-team-contribution', async run(c) {
        const b = await openBuilder(c, 'Release coordinator', 15);
        await b.send('role', 'Shift coordinator');
        await b.send('employer', null, { mode: 'skip' });
        await b.send('dates', null, { mode: 'unknown' });
        await b.send('project', 'Dry run');
        const team = "Our team rehearsed the handoff. I wasn't the release owner.";
        const scope = await b.send('scope', team, { suggestion: { suggestion: { question: 1 } },
          inspect: p => assert.ok(p.options.some(q => /distinct from the team/i.test(q))) });
        assert.equal(scope.turns.at(-1).selectedBy, 'model');
        check(scope.turns.at(-1).text, { need: [/which part was yours|personally do/i], avoid: [/decision about the rollout/i] });
        const choice = 'I chose a dry run for the handoff because the rollback risk worried me.';
        const next = await b.send('action', choice, { suggestion: { suggestion: { question: 1 } },
          inspect: p => assert.ok(p.options.some(q => /risk/i.test(q))) });
        assert.equal(next.turns.at(-1).selectedBy, 'model');
        check(next.turns.at(-1).text, { need: [/risk|alternative/i] });
        const lib = await proposals(c, [team, choice], { builderTurns: next.turns });
        const role = lib.nodes.find(n => n.kind === 'role');
        assert.ok(role && !role.employer && !role.dates);
        assert.ok(lib.nodes.some(n => n.label === 'Dry run' && n.parentRoleId === role.id));
      } },
      { id: 'invalid-probe-cannot-rewrite-answer', lanes: ['replay'], async run(c) {
        const b = await openBuilder(c, 'Display technician', 5);
        await b.send('role', 'Assistant installer');
        await b.send('project', 'Display trial');
        const scope = 'We rehearsed the display change as a team. I did not own the installation.';
        const next = await b.send('scope', scope, { suggestion: { suggestion: { question: 99, quote: 'We rehearsed the display change as a team.' } } });
        assert.equal(next.turns.at(-1).selectedBy, 'guide');
        check(next.turns.at(-1).text, { need: [/yours|personally/i] });
        await proposals(c, [scope], { builderTurns: next.turns });
      } }
    ]
  }
];
