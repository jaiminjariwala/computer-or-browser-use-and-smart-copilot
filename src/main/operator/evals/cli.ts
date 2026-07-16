import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { formatCostUsd } from '../shared/usage'
import { runOperatorEvals } from './runner'
import type { OperatorEvalReport } from './types'

const DEFAULT_REPORT_PATH = 'artifacts/operator-evals/latest.json'

function outputPath(args: readonly string[]): string {
    const inline = args.find((arg) => arg.startsWith('--output='))
    if (inline) return inline.slice('--output='.length)
    const flagIndex = args.indexOf('--output')
    if (flagIndex >= 0) {
        const value = args[flagIndex + 1]
        if (!value || value.startsWith('--')) {
            throw new Error('--output requires a file path')
        }
        return value
    }
    return DEFAULT_REPORT_PATH
}

function percent(value: number): string {
    return `${(value * 100).toFixed(1)}%`
}

function pad(value: string | number, width: number): string {
    return String(value).slice(0, width).padEnd(width)
}

function printReport(report: OperatorEvalReport, reportPath: string): void {
    console.log('\nOperator AgentLoop evaluation')
    console.log('='.repeat(124))
    console.log(
        [
            pad('Scenario', 31),
            pad('Kind', 10),
            pad('Check', 7),
            pad('Goal', 7),
            pad('Final state', 18),
            pad('Steps', 7),
            pad('Exec', 7),
            pad('Fail', 7),
            pad('Block', 7),
            pad('Retry', 7),
            pad('Tokens', 9),
            pad('Eff.', 7)
        ].join(' ')
    )
    console.log('-'.repeat(124))
    for (const scenario of report.scenarios) {
        const metrics = scenario.metrics
        const goalStatus = scenario.kind === 'goal'
            ? metrics.taskSucceeded ? 'YES' : 'NO'
            : 'n/a'
        const efficiency = metrics.efficiency.score === null
            ? 'n/a'
            : metrics.efficiency.score.toFixed(1)
        console.log(
            [
                pad(scenario.name, 31),
                pad(scenario.kind, 10),
                pad(scenario.passed ? 'PASS' : 'FAIL', 7),
                pad(goalStatus, 7),
                pad(metrics.finalState, 18),
                pad(metrics.steps, 7),
                pad(metrics.executedActions, 7),
                pad(metrics.actionFailures, 7),
                pad(metrics.blockedActions, 7),
                pad(metrics.reasoningRetries, 7),
                pad(metrics.tokens.totalTokens, 9),
                pad(efficiency, 7)
            ].join(' ')
        )
    }
    console.log('-'.repeat(124))
    const summary = report.summary
    console.log(
        `Scenario checks: ${summary.passedCount}/${summary.scenarioCount} ` +
        `(${percent(summary.passRate)}) | Goal success: ${summary.goalSuccessCount}/` +
        `${summary.goalScenarioCount} (${percent(summary.goalSuccessRate)}) | ` +
        `Guardrail checks: ${summary.guardrailPassedCount}/${summary.guardrailScenarioCount} ` +
        `(${percent(summary.guardrailPassRate)})`
    )
    console.log(
        `Totals: ${summary.totals.steps} steps, ${summary.totals.proposedActions} proposed, ` +
        `${summary.totals.executedActions} executed, ${summary.totals.actionFailures} executor ` +
        `failures, ${summary.totals.blockedActions} blocked, ` +
        `${summary.totals.reasoningFailures} reasoning failures, ` +
        `${summary.totals.reasoningRetries} actual retries, ` +
        `${summary.totals.tokens.totalTokens} tokens, ` +
        `${formatCostUsd(summary.totals.estimatedCostUsd ?? undefined) ?? 'unknown cost'}`
    )
    console.log(`Average goal efficiency: ${summary.averageGoalEfficiency.toFixed(1)} / 100`)
    console.log(`JSON report: ${reportPath}\n`)

    for (const scenario of report.scenarios.filter((result) => !result.passed)) {
        console.error(`${scenario.name} failed expectations:`)
        for (const assertion of scenario.assertions.filter((item) => !item.passed)) {
            console.error(
                `  - ${assertion.metric}: expected ${String(assertion.expected)}, ` +
                `received ${String(assertion.actual)}`
            )
        }
    }
}

async function main(): Promise<void> {
    const reportPath = path.resolve(process.cwd(), outputPath(process.argv.slice(2)))
    const report = await runOperatorEvals()
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    printReport(report, reportPath)
    if (!report.passed) process.exitCode = 1
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Operator evaluation failed: ${message}`)
    process.exitCode = 1
})
