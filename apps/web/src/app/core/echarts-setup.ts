/** Only the ECharts pieces Cadence draws, loaded lazily with the first chart. */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { DatasetComponent, GridComponent, LegendComponent, TooltipComponent, AriaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, DatasetComponent, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer]);

export default echarts;
