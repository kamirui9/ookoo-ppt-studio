import type {Layout, RefineRequest, GenerateRequest, ServiceStatus} from '../shared/types';
// 这些故意错误的例子验证共享契约确实会阻止错误字段与值。
// @ts-expect-error 未声明的版式必须被拒绝
const invalidLayout: Layout = 'unknown-layout';
// @ts-expect-error 指令必须是字符串
const invalidRefine: RefineRequest = {version: 1, instruction: 42};
// @ts-expect-error 生图确认必须是布尔值
const invalidGenerate: GenerateRequest = {version: 1, phase: 'samples', confirm: 'yes'};
// @ts-expect-error 密钥不得成为公开状态字段
const invalidStatus: ServiceStatus = {apiKey: 'secret'};
void [invalidLayout, invalidRefine, invalidGenerate, invalidStatus];
