using System;

class Program
{
    static void Main()
    {
        int chislo = int.Parse(Console.ReadLine());
        int otvet = 0;

        for (int i = 1; i <= chislo; i++)
        {
            if (chislo % i == 0)
            {
                otvet = otvet + 1;
            }
        }

        Console.WriteLine(otvet);
    }
}