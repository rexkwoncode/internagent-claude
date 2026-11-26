# ML search sequence

`/internagent:run` loads project options with `engine: "InternAgent"` and a nested `mlevolve` configuration. InternAgent owns the research loop. MLEvolve runs a separate candidate search for each selected hypothesis. Both engines use the same signed-in Claude Code session for inference. [Configure the backend](upstream-runtime.md#mlevolve-as-internagents-ml-backend).

```mermaid
sequenceDiagram
    participant Claude as Claude Code plugin
    participant IA as InternAgent
    participant Bridge as Local model mailbox
    participant ML as MLEvolve
    participant Eval as Fixed evaluator
    participant Memory as InternAgent TaskMemory

    Claude->>IA: Start /internagent:run with project options
    alt Generate ideas
        IA->>Bridge: Request hypotheses, critique, ranking, and methods
        Claude->>Bridge: Pick up requests and return model responses
        Bridge-->>IA: Return responses
    else Use supplied ideas
        IA->>IA: Load ideas from the seed file
    end

    loop Each selected hypothesis
        IA->>ML: Start search with the hypothesis, method, and development data
        loop Candidate search
            ML->>Bridge: Request planning, code, or review
            Claude->>Bridge: Return model responses through the signed-in session
            Bridge-->>ML: Return responses
            ML->>ML: Execute and validate candidates
            Note right of ML: Save scored nodes in search memory when enabled
        end
        alt Search returns a winner
            ML-->>IA: Return the winning code and submission
            IA->>Eval: Evaluate the winner on the fixed development protocol
            Eval-->>IA: Return measured metrics or an evaluation error
        else Search fails
            ML-->>IA: Return the search failure
        end
        alt Measured result available
            IA->>Memory: Save baseline and winner metrics when enabled
        else Experiment fails
            IA->>IA: Record the failed experiment and preserve its logs
        end
    end
    IA-->>Claude: Return run status, summary, and artifact paths
```

In incremental mode, InternAgent can carry the winning code and measured baseline into the next round. MLEvolve receives that code as a reference. A final holdout can be scored separately after selection.
