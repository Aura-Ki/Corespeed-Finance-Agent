import {
    AnthropicModelProvider,
    createZypherContext,
    ZypherAgent,
} from "jsr:@zypher/agent";
import { eachValueFrom } from "npm:rxjs-for-await";
import { parse } from "jsr:@std/csv";
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs";

// =============== Types ===================
interface Transaction {
    date: string;
    merchant: string;
    amount: number;
    category: string;
    description?: string;
}

interface Report {
    totals: {
        transactionCount: number;
        totalSpent: number;
        avgSpendPerTxn: number;
    };
    byCategory: Record<string, number>;
    byMonth: Record<string, number>;
    topMerchants: Array<{ merchant: string; spent: number; count: number }>;
    budget: Record<string, number>;
    forecast: {
        nextMonthSpend: number;
        confidence: string;
        method: string;
    } | null;
    healthScore: {
        score: number;
        summary: string;
    };
    periodHint: {
        start: string;
        end: string;
        monthsDetected: number;
    };
}

interface SessionData {
    sessionId: string;
    transactions: Transaction[];
    fileName: string;
    currency: string;
    conversationHistory: Array<{ role: string; content: string }>;
}

// ================ State Management ====================
const sessions = new Map<string, SessionData>();

function generateSessionId(): string {
    return crypto.randomUUID();
}

// ==================== File Parsing ====================
async function parseCSV(content: string): Promise<Transaction[]> {
    const lines = content.split('\n').filter(line => line.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
    const transactions: Transaction[] = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const dateIdx = headers.findIndex(h => h.includes('date'));
        const merchantIdx = headers.findIndex(h => h.includes('merchant') || h.includes('description') || h.includes('name'));
        const amountIdx = headers.findIndex(h => h.includes('amount') || h.includes('price') || h.includes('total'));
        const descIdx = headers.findIndex(h => h.includes('description'));

        if (dateIdx >= 0 && amountIdx >= 0) {
        const amount = Math.abs(parseFloat(values[amountIdx].replace(/[^0-9.-]/g, '')));
        const merchant = values[merchantIdx] || "Unknown";
        const description = values[descIdx] || merchant;
        
        // 自动分类
        const category = categorizeTransaction(description, merchant);

        transactions.push({
            date: values[dateIdx] || new Date().toISOString().split('T')[0],
            merchant,
            amount: isNaN(amount) ? 0 : amount,
            category,
            description,
        });
        }
    }

    return transactions;
}

async function parseExcel(arrayBuffer: ArrayBuffer): Promise<Transaction[]> {
    try {
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        // Convert sheet to JSON
        const jsonData = XLSX.utils.sheet_to_json(sheet);
        
        if (!jsonData || jsonData.length === 0) return [];
        
        // Map to transactions
        const transactions: Transaction[] = [];
        
        for (const row of jsonData as any[]) {
        // Find date field (case-insensitive)
        const dateKey = Object.keys(row).find(k => 
            k.toLowerCase().includes('date')
        );
        
        // Find merchant field
        const merchantKey = Object.keys(row).find(k => 
            k.toLowerCase().includes('merchant') || 
            k.toLowerCase().includes('description') || 
            k.toLowerCase().includes('name')
        );
        
        // Find amount field
        const amountKey = Object.keys(row).find(k => 
            k.toLowerCase().includes('amount') || 
            k.toLowerCase().includes('price') || 
            k.toLowerCase().includes('total')
        );
        
        // Find category field
        const categoryKey = Object.keys(row).find(k => 
            k.toLowerCase().includes('category') || 
            k.toLowerCase().includes('type')
        );
        
        if (dateKey && amountKey) {
            const amountStr = String(row[amountKey]).replace(/[^0-9.-]/g, '');
            const amount = Math.abs(parseFloat(amountStr));
            
            transactions.push({
            date: row[dateKey] || new Date().toISOString().split('T')[0],
            merchant: row[merchantKey || ''] || 'Unknown',
            amount: isNaN(amount) ? 0 : amount,
            category: row[categoryKey || ''] || 'Uncategorized',
            });
        }
        }
        
        return transactions;
    } catch (error) {
        console.error('Excel parsing error:', error);
        return [];
    }
}

async function parsePDF(arrayBuffer: ArrayBuffer): Promise<Transaction[]> {
    console.log('PDF parsing not fully implemented - using sample data');
    return [];
}

const CATEGORY_RULES = [
    { category: "Dining", keywords: ["restaurant", "cafe", "coffee", "starbucks", "dinner", "lunch", "food", "grill", "bistro", "sakura"] },
    { category: "Groceries", keywords: ["grocery", "supermarket", "whole foods", "market", "trader"] },
    { category: "Transport", keywords: ["uber", "lyft", "gas", "fuel", "shell", "exxon", "ride", "taxi"] },
    { category: "Subscriptions", keywords: ["netflix", "spotify", "prime", "subscription", "membership", "gym", "fitness", "icloud"] },
    { category: "Shopping", keywords: ["amazon", "shop", "purchase", "store", "mall", "target", "walmart"] },
    { category: "Entertainment", keywords: ["movie", "cinema", "theater", "ticket", "game", "ppac"] },
    { category: "Utilities", keywords: ["electric", "water", "internet", "phone", "utility", "bill"] },
    { category: "Health", keywords: ["pharmacy", "doctor", "clinic", "medical", "hospital", "cvs"] },
];

function categorizeTransaction(description: string, merchant: string): string {
    const text = `${description} ${merchant}`.toLowerCase();
    
    for (const rule of CATEGORY_RULES) {
        if (rule.keywords.some(keyword => text.includes(keyword))) {
        return rule.category;
        }
    }
    
    return "Other";
}

// ================ Report Generation =================
function generateReport(transactions: Transaction[]): Report {
    if (transactions.length === 0) {
        return {
        totals: { transactionCount: 0, totalSpent: 0, avgSpendPerTxn: 0 },
        byCategory: {},
        byMonth: {},
        topMerchants: [],
        budget: {},
        forecast: null,
        healthScore: { score: 0, summary: 'No data available' },
        periodHint: { start: '', end: '', monthsDetected: 0 },
        };
    }

    // Calculate totals
    const totalSpent = transactions.reduce((sum, t) => sum + t.amount, 0);
    const transactionCount = transactions.length;
    const avgSpendPerTxn = totalSpent / transactionCount;

    // By category
    const byCategory: Record<string, number> = {};
    transactions.forEach(t => {
        byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
    });

    // By month
    const byMonth: Record<string, number> = {};
    transactions.forEach(t => {
        const month = t.date.substring(0, 7); // YYYY-MM
        byMonth[month] = (byMonth[month] || 0) + t.amount;
    });

    // Top merchants
    const merchantMap: Record<string, { spent: number; count: number }> = {};
    transactions.forEach(t => {
        if (!merchantMap[t.merchant]) {
        merchantMap[t.merchant] = { spent: 0, count: 0 };
        }
        merchantMap[t.merchant].spent += t.amount;
        merchantMap[t.merchant].count += 1;
    });
    
    const topMerchants = Object.entries(merchantMap)
        .map(([merchant, data]) => ({ merchant, ...data }))
        .sort((a, b) => b.spent - a.spent)
        .slice(0, 10);

    // Budget (simple suggestion based on categories)
    const budget: Record<string, number> = {};
    Object.entries(byCategory).forEach(([cat, spent]) => {
        budget[cat] = Math.ceil(spent * 1.1); // 10% buffer
    });

    // Forecast
    const months = Object.keys(byMonth).sort();
    let forecast = null;
    if (months.length >= 2) {
        const recentMonths = months.slice(-3);
        const avgRecent = recentMonths.reduce((sum, m) => sum + byMonth[m], 0) / recentMonths.length;
        forecast = {
        nextMonthSpend: Math.round(avgRecent),
        confidence: months.length >= 3 ? 'High' : 'Medium',
        method: 'Average of last 3 months',
        };
    }

    // Health score (simple calculation)
    const avgMonthly = totalSpent / Object.keys(byMonth).length;
    let score = 75;
    if (avgMonthly > 3000) score -= 15;
    if (avgMonthly > 5000) score -= 10;
    if (byCategory['Dining'] && byCategory['Dining'] > totalSpent * 0.3) score -= 10;
    
    const healthScore = {
        score: Math.max(0, Math.min(100, score)),
        summary: score >= 80 ? 'Excellent financial health!' : 
                score >= 60 ? 'Good, with room for improvement' : 
                'Consider reducing spending',
    };

    // Period hint
    const dates = transactions.map(t => t.date).sort();
    const periodHint = {
        start: dates[0],
        end: dates[dates.length - 1],
        monthsDetected: Object.keys(byMonth).length,
    };

    return {
        totals: { transactionCount, totalSpent, avgSpendPerTxn },
        byCategory,
        byMonth,
        topMerchants,
        budget,
        forecast,
        healthScore,
        periodHint,
    };
}

// ================= AI Agent ==================
async function initAgent() {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }

    const zypherContext = await createZypherContext(Deno.cwd());
    
    const agent = new ZypherAgent(
        zypherContext,
        new AnthropicModelProvider({ apiKey }),
    );

    return agent;
}

async function chatWithAgent(
    agent: ZypherAgent,
    sessionData: SessionData,
    userMessage: string
    ): Promise<{ message: string; report?: Report }> {
    // 基于当前 session 的 txn 生成 report
    const report = generateReport(sessionData.transactions);

    if (!Array.isArray(sessionData.conversationHistory)) {
        sessionData.conversationHistory = [];
    }

    const historyText =
        sessionData.conversationHistory.length > 0
        ? sessionData.conversationHistory
            .slice(-8) // 最近 8 轮
            .map((m) => `${String(m.role).toUpperCase()}: ${m.content}`)
            .join("\n")
        : "";

    // system prompt（
    const systemPrompt = `You are BillSense, a helpful financial advisor AI.

    You are given a user's transaction summary and must answer with:
    - Concrete numbers (totals, category sums, comparisons)
    - Short reasoning
    - 1-3 actionable recommendations
    Keep it concise, but specific.

    Transaction Summary:
    - Total Transactions: ${report.totals.transactionCount}
    - Total Spent: $${report.totals.totalSpent.toFixed(2)}
    - Average per Transaction: $${report.totals.avgSpendPerTxn.toFixed(2)}
    - Period: ${report.periodHint.start} to ${report.periodHint.end}

    Spending by Category:
    ${Object.entries(report.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `- ${cat}: $${amt.toFixed(2)}`)
    .join("\n")}

    Monthly Spending:
    ${Object.entries(report.byMonth)
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([month, amt]) => `- ${month}: $${amt.toFixed(2)}`)
    .join("\n")}

    Top Merchants:
    ${report.topMerchants
    .slice(0, 5)
    .map((m) => `- ${m.merchant}: $${m.spent.toFixed(2)} (${m.count} txns)`)
    .join("\n")}
    `;

    try {
        const taskPrompt = [
        systemPrompt,
        historyText ? `Conversation so far:\n${historyText}` : "",
        `User Question: ${userMessage}`,
        ]
        .filter(Boolean)
        .join("\n\n");

        const event$ = agent.runTask(taskPrompt, "claude-sonnet-4-20250514");

        let fullResponse = "";

        for await (const event of eachValueFrom(event$)) {
        const e: any = event;

        // 拼接string
        const chunk =
            (typeof e.text === "string" && e.text) ||
            (typeof e.delta === "string" && e.delta) ||
            (typeof e.content === "string" && e.content) ||
            (typeof e.content?.text === "string" && e.content.text) ||
            (typeof e.message?.content === "string" && e.message.content) ||
            (typeof e.message?.content?.text === "string" &&
            e.message.content.text) ||
            "";

        if (chunk) fullResponse += chunk;
        }

        const finalText =
        fullResponse.trim() ||
        "I received your question but couldn't generate a response. Please try rephrasing.";

        // 写回 session 的对话历史
        sessionData.conversationHistory.push({ role: "user", content: userMessage });
        sessionData.conversationHistory.push({
        role: "assistant",
        content: finalText,
        });

        // 是否需要更新右侧 report
        const q = userMessage.toLowerCase();
        const shouldUpdateReport =
        q.includes("analy") ||
        q.includes("report") ||
        q.includes("chart") ||
        q.includes("trend") ||
        q.includes("budget") ||
        q.includes("forecast") ||
        q.includes("update");

        return {
        message: finalText,
        report: shouldUpdateReport ? report : undefined,
        };
    } catch (error) {
        console.error("[Agent Error] chatWithAgent failed:", error);
        return {
        message: "I encountered an error. Please try again with a simpler question.",
        };
    }
}


// ================== HTTP Server ==================
async function handleUpload(req: Request): Promise<Response> {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        
        if (!file) {
        return new Response(
            JSON.stringify({ error: 'No file provided' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
        }

        const fileName = file.name;
        const fileExt = fileName.split('.').pop()?.toLowerCase();
        
        let transactions: Transaction[] = [];
        
        if (fileExt === 'csv') {
        const content = await file.text();
        transactions = await parseCSV(content);
        } else if (fileExt === 'xlsx' || fileExt === 'xls') {
        const buffer = await file.arrayBuffer();
        transactions = await parseExcel(buffer);
        } else if (fileExt === 'pdf') {
        const buffer = await file.arrayBuffer();
        transactions = await parsePDF(buffer);
        } else {
        return new Response(
            JSON.stringify({ error: 'Unsupported file type' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
        }

        // Create session
        const sessionId = generateSessionId();
        const sessionData: SessionData = {
        sessionId,
        transactions,
        fileName,
        currency: 'USD',
        conversationHistory: [],
        };
        
        sessions.set(sessionId, sessionData);

        const report = generateReport(transactions);

        return new Response(
        JSON.stringify({
            sessionId,
            fileName,
            currency: 'USD',
            report,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
        JSON.stringify({ error: 'Failed to process file' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

async function handleChat(req: Request, agent: ZypherAgent): Promise<Response> {
    try {
        const body = await req.json();
        const { sessionId, message } = body;

        if (!sessionId || !message) {
        return new Response(
            JSON.stringify({ error: 'Missing sessionId or message' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
        }

        const sessionData = sessions.get(sessionId);
        if (!sessionData) {
        return new Response(
            JSON.stringify({ error: 'Invalid session' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
        }

        const result = await chatWithAgent(agent, sessionData, message);

        return new Response(
        JSON.stringify(result),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Chat error:', error);
        return new Response(
        JSON.stringify({ error: 'Failed to process chat' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

// ==================== Main Server ====================
async function main() {
    console.log('Initializing BillSense Finance Agent...');
    
    const agent = await initAgent();
    console.log('Agent initialized');

    const port = 8000;
    
    Deno.serve({ port }, async (req: Request) => {
        const url = new URL(req.url);
        const path = url.pathname;

        // CORS headers
        const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
        }

        // Serve static files
        if (path === '/' || path === '/index.html') {
        try {
            const file = await Deno.readFile('./public/index.html');
            return new Response(file, {
            headers: { 'Content-Type': 'text/html', ...corsHeaders },
            });
        } catch {
            return new Response('index.html not found', { status: 404 });
        }
        }

        if (path === '/sample_txns.csv') {
        try {
            const file = await Deno.readFile('./sample_txns.csv');
            return new Response(file, {
            headers: { 'Content-Type': 'text/csv', ...corsHeaders },
            });
        } catch {
            return new Response('sample file not found', { status: 404 });
        }
        }

        // API routes
        if (path === '/api/upload' && req.method === 'POST') {
        const response = await handleUpload(req);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, {
            status: response.status,
            headers,
        });
        }

        if (path === '/api/chat' && req.method === 'POST') {
        const response = await handleChat(req, agent);
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, {
            status: response.status,
            headers,
        });
        }

        return new Response('Not Found', { status: 404 });
    });

    console.log(`Server running at http://localhost:${port}`);
    console.log('BillSense Finance Agent is ready!');
    }

    // Run the server
    if (import.meta.main) {
        main();
}