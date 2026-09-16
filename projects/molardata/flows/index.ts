/** MolarData 流程积木。登录由 project.yaml 的 login 配置驱动（@uta/flows 通用登录），这里只放业务积木 */
import { ensureTask, openTaskPage } from './task'

export default [ensureTask, openTaskPage]
