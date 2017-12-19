public class SteamedMilk extends CondimentsDecorator {
	Beverage beverage;

	public SteamedMilk(Beverage beverage) {
		this.beverage = beverage;
	}

	public String getDescription() {
		return beverage.getDescription() + ", Steamed Milk";
	}

	public double cost() {
		return beverage.cost() + .10;
	}
}