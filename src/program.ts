import { Command } from 'commander';
import * as ARB from './arbitrage_old6';
import { DEFAULT_TOKEN_NUMBER, DEFAULT_TIMEOUT, DEX } from './constants';
import { sleep } from './utils';

const inquirer = require('inquirer');
const program = new Command();

// CMD: Start
program
    .command('start')
    .option('--tokens <number>', 'number of highest daily volume tokens to consider')
    .option('--timeout <seconds>', 'polling timeout')
    .option('--dex <dexes...>', 'select considered dexes (uniswap, sushiswap, or both)')
    .option('-d --debug', 'enable debug mode')
    .description('begin searching for dex cycles repeatedly')
    .action(async (options) => {
        const timeout: number = (options.timeout) ? options.timeout * 1000 : DEFAULT_TIMEOUT;
        const numberTokens: number = (options.tokens) ? options.tokens : DEFAULT_TOKEN_NUMBER;
        const debug: boolean = (options.debug) ? true : false;
        const dexs: Set<DEX> = await parseDexs(options);
        while (true) {
            await ARB.main(numberTokens, dexs, debug);
            await sleep(timeout);
        }
    });

// CMD: Run
program
    .command('run')
    .option('--tokens <number>', 'number of highest daily volume tokens to consider')
    .option('--dex <dexes...>', 'select considered dexes (uniswap, sushiswap, or both)')
    .option('-d --debug', 'enable debug mode')
    .description('search once for dex cycles')
    .action(async (options) => {
        const numberTokens: number = (options.tokens) ? options.tokens : DEFAULT_TOKEN_NUMBER;
        const dexs: Set<DEX> = await parseDexs(options);
        const debug: boolean = (options.debug) ? true : false;
        await ARB.main(numberTokens, dexs, debug);
    });

async function parseDexs(options: any) {
    let dexs: Set<DEX> = new Set();
    if (options.dex) {
        if (Array.isArray(options.dex)) {
            if (options.dex.includes('uniswap') || options.dex.includes('both')) dexs.add(DEX.UniswapV3);
            if (options.dex.includes('sushiswap') || options.dex.includes('both')) dexs.add(DEX.Sushiswap);
        } else {
            const dexAnswers = await inquireDex();
            if (dexAnswers.DEXs.includes('UniswapV3')) dexs.add(DEX.UniswapV3);
            if (dexAnswers.DEXs.includes('Sushiswap')) dexs.add(DEX.Sushiswap);
            if (dexAnswers.DEXs.includes('Both')) {
                dexs.add(DEX.UniswapV3);
                dexs.add(DEX.Sushiswap);
            }
        }
    } else {
        // Si no se especifica, usa ambos por defecto
        dexs.add(DEX.UniswapV3);
        dexs.add(DEX.Sushiswap);
    }
    return dexs;
}

async function inquireDex() {
    return inquirer
                .prompt([
                    {
                        type: 'list',
                        message: 'Select DEXs',
                        name: 'DEXs',
                        choices: [
                            { name: 'UniswapV3' },
                            { name: 'Sushiswap' },
                            { name: 'Both (UniswapV3 and Sushiswap)' }
                        ],
                        validate(answer) {
                            if (answer.length < 1) return 'You must choose at least one option.';
                            return true;
                        },
                    },
                ])
                .then((answers) => {
                    return answers;
                }); 
}

program.parse();