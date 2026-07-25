# QWEN-multi-agent-coding-harness
This is for the Qwen hackathon. Track 3.
Ant system. Ants are the most effective societal system for building long term infrastructure. 
Hierarchy. From subagent swarms of executors, to the 


1. Core Principles from Ant Societies

Stigmergy (Indirect Communication via the Environment)

Ants don’t hold meetings. They leave pheromone trails on the ground, and those chemical signals guide the next ant’s behavior. In software, the codebase itself, along with its metadata, is the environment. Instead of agents chatting directly, they leave digital “scent marks” on files, issues, tasks, and test results.

Division of Labour & Threshold-Based Task Allocation

Ants have different castes (foragers, nurses, soldiers), but roles are fluid. An ant will switch tasks based on local cues and its internal threshold. For example, if a forager encounters many hungry larvae, it may switch to nursing. In a coding harness, agents can have base roles (architect, implementer, reviewer) but dynamically take on whatever task has the strongest signal.

Positive & Negative Feedback Loops

Positive feedback: A successful trail is reinforced by more ants using it, leading to a single foraging path. In coding, a passing build or a well-reviewed function becomes more attractive for further polishing or reuse.
Negative feedback: Pheromone evaporates. Stale, solved, or buggy code areas lose attraction over time, preventing the team from piling onto dead ends.
Emergent Intelligence

No single ant understands the colony’s architecture. Simple local rules (follow the strongest scent, drop a scent when returning with food) yield global patterns like shortest-path finding. Similarly, your harness won’t need a master planner—agents will make local decisions that collectively produce a coherent codebase.

2. Designing the “Ant Colony Coding Harness”

Imagine a shared environment where multiple AI coding agents (each wrapped in a simple loop) continuously browse, edit, and test code. Coordination happens entirely through the artifacts they leave behind.

The Environment (The Digital Anthill)

Code Repository: Git-based, with a structured directory.
Shared Task Board: A Kanban-like board where each task is a “food source” with a dynamic pheromone level.
Code Annotations: A metadata layer (could be JSON files, comment tags, or a vector DB) where agents can deposit interest score, quality score, warning flags, and dependency markers.
CI/CD & Test Results: Automatically update pheromone levels—passing tests increase a module’s attractiveness, failures trigger a distress signal.
Agent Design (The Ants)

Each agent is a stateless AI (LLM) instance with tools:

read_file(path), write_file(path, content)
run_tests(module)
deposit_pheromone(target, type, strength)
sense_environment() – returns local tasks and files sorted by pheromone intensity.
execute_task(task) – given a task description and context, generates a code patch.
Agents can have a “caste” (e.g., forager, builder, healer) that biases their threshold for picking certain types of work, but they can freely switch.

The Pheromone System (Coordination Medium)

Define a few pheromone types, modeled on ant trail pheromones, alarm pheromones, and colony odour:

Pheromone Type	Meaning in Codebase	Deposition Rule	Decay
Attraction (task trail)	This task/file needs work / is promising.	Agent picks up a task and deposits when it starts working; intensified when it completes something useful.	Slowly evaporates (e.g., multiply by 0.99 each cycle).
Quality (food source quality)	This module is well-tested, clean, and reusable.	Increased by successful builds, passing tests, and positive code review.	Decays only if the module remains untouched—old, unmaintained code gradually loses its shine.
Alarm (distress)	Bug detected, build failing, breaking change.	Automatically deposited by CI failure or an agent that discovers an issue.	Very high initial spike, then rapid decay (like a shout that fades).
Trail Marker (exploration)	“I was here” marker to avoid redundant work.	Agent drops a short-lived marker when it visits a file.	Very fast decay (minutes) – just enough to prevent two agents from editing the same region simultaneously.
All pheromone values are stored in a simple key-value store (file + line region → scores) that agents read/write.

3. How a Coding Session Unfolds (The Ant Algorithm)

1. Initialization

A high-level requirement is broken down into concrete tasks (by a human or an “architect” ant) and placed on the task board with moderate initial attraction pheromone.
The codebase starts with neutral quality scores.
2. Agent Loop (each agent runs asynchronously)
Every agent cycles through:

text
while True:
    # 1. Sense the environment
    local_tasks = get_tasks_sorted_by_attraction(threshold=my_threshold)
    if local_tasks is empty:
        # explore: pick a random file with low quality score
        file = pick_random_file_with_low_quality()
        improve(file)
        continue

    # 2. Pick the strongest task (like following the strongest pheromone trail)
    task = local_tasks[0]
    claim_task(task)  # deposit a temporary "trail marker"

    # 3. Execute the task
    patch = generate_code(task, sense_related_files())
    if patch:
        apply_patch(patch)
        run_tests(task.module)
        if tests_pass:
            # Positive reinforcement
            deposit_pheromone(task, type='quality', strength=+2)
            deposit_pheromone(task, type='attraction', strength=+1)  # maybe nearby tasks also benefit
        else:
            # Alarm signal
            deposit_pheromone(task, type='alarm', strength=+5)
            # Optionally, revert the patch and try a different approach
    else:
        # Could not solve; deposit a small negative attraction to let others try
        deposit_pheromone(task, type='attraction', strength=-0.5)

    # 4. Evaporate all pheromones slightly (global process, but agents can also do it)
3. Self-Organization in Action

If a task repeatedly fails tests, alarm pheromone spikes, attracting “healer” agents to fix the build first.
A well-crafted module acquires high quality scent, drawing builder agents to reuse it in new features.
Once a task is completed and verified, its attraction pheromone evaporates quickly, so agents naturally move on.
The system avoids central bottlenecks: multiple agents can work on separate parts of the codebase, and trail markers prevent collisions.
4. Concrete Implementation Sketch

You can build this as a Python harness with today’s LLM APIs. Here’s a minimal architecture:

python
# Simplified data store (could be Redis, SQLite, or just JSON on disk)
pheromone_store = {
    "tasks": {
        "task_1": {"attraction": 0.8, "alarm": 0.0, "quality": 0.0},
        "task_2": {"attraction": 0.5, ...}
    },
    "files": {
        "src/main.py": {"quality": 0.2, "trail_marker": 0.0}
    }
}

def agent_loop(agent_id, caste_bias="builder"):
    while True:
        # sense
        tasks = get_eligible_tasks(threshold=caste_bias)
        if tasks:
            task = pick_by_roulette_wheel(tasks)  # probabilistic based on attraction
            work_on(task)
        else:
            # explore low-quality files
            file = pick_low_quality_file()
            improve(file)
        time.sleep(5)  # gentle pace
Tools for the LLM agent:

view_task(task_id) – returns description, current pheromone context.
propose_change(task_id, diff) – the harness applies the diff (in a sandbox).
report_result(success, details) – triggers pheromone deposition.
Task breakdown can itself be an ant behavior: a “scout” ant browses the issue tracker and, upon finding a large task, splits it into subtasks, depositing attraction trails linking them.

5. The “Incredible Feats” Mapping

Ant colonies build intricate nests, regulate traffic, and optimise foraging routes. Here’s how those map to software:

Trail optimization → Dynamic CI prioritization.
A module with high alarm pheromone gets more testing resources. A feature branch with many recent commits gets stronger attraction, pulling agents to keep it moving.
Nest construction → Feature scaffolding.
Builder ants don’t need a blueprint; they follow local rules (if there’s a pillar here, build a wall at this angle). Similarly, agents can scaffold code by reacting to adjacent files: “if I see a new API endpoint, generate the corresponding test file and documentation stub, then deposit attraction on those new tasks.”
Caste plasticity → Adaptive workflows.
If a critical bug is found (alarm pheromone surge), even agents with a “feature builder” bias drop their work and swarm to fix it. No manager reassigns them.
Robustness → Fault tolerance.
If one agent crashes or produces garbage, other agents are not blocked. The negative feedback (alarm, low quality scores) ensures the bad code is rapidly revisited or overwritten.
6. Getting Started: A Minimal Viable Anthill

Pick a small project (e.g., a simple API or library).
Set up the environment: a Git repo, a task list (Markdown files with YAML frontmatter for pheromone fields), and a test suite that can be run automatically.
Implement a dummy pheromone store – a Python dict saved as JSON, with a loop that decays values periodically.
Create a single agent that:

Reads the task list and picks the one with the highest attraction / (1 + alarm).
Uses an LLM to generate a patch.
Runs the tests and updates the pheromone store accordingly.
Run multiple instances of that agent loop concurrently (different terminals/processes) and watch how work distribution emerges without a scheduler.
Iterate: add trail markers to prevent collisions, introduce quality pheromone for code reuse, allow agents to create new tasks by depositing attraction on unimplemented function stubs.
7. Potential Pitfalls & Ant-Style Solutions

Oscillation: Agents might bounce between two tasks. Solution: a short-term “commitment” marker that slightly raises the threshold for switching.
Over-swarming: Everyone rushes to the same high-attraction task, causing conflicts. Solution: trail markers that repel additional agents from a file currently being edited.
Stagnation: Old low-quality modules never get improved because they have no attraction. Solution: an “explorer” caste that periodically picks the lowest-quality file and tries to refactor it.
