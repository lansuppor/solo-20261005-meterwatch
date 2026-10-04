const name: string = 'meterwatch';
const args: string[] = process.argv.slice(2);

if (args.length > 0 && !(args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.error(name + ': unknown arguments; use --help');
  process.exitCode = 2;
} else {
  console.log(name + '\n\nUsage: node app.ts [--help]\n\n建筑能耗监测与告警。当前仅提供帮助信息。');
}
